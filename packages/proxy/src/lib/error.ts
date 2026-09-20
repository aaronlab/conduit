import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { isRecord } from "./validation"

/** Max upstream response body length persisted in logs / DB. */
const MAX_BODY_LENGTH = 512

export class HTTPError extends Error {
  status: number
  responseBody: string
  headers: Headers

  constructor(message: string, status: number, responseBody: string = "", headers?: Headers) {
    super(message)
    this.status = status
    this.responseBody = responseBody
    this.headers = new Headers(headers)
  }

  /**
   * Eagerly reads the response body so it can be logged and forwarded
   * without worrying about the one-shot `Response.body` stream.
   */
  static async fromResponse(
    message: string,
    response: Response,
  ): Promise<HTTPError> {
    let body: string
    try {
      body = await response.text()
    } catch (error) {
      body = `Could not read the upstream error response: ${error instanceof Error ? error.message : String(error)}`
    }
    return new HTTPError(message, response.status, body, response.headers)
  }
}

export class InvalidRequestError extends HTTPError {
  readonly code: string

  constructor(message: string, param?: string, code = "invalid_request") {
    super(message, 400, JSON.stringify({
      error: { message, type: "invalid_request_error", code, ...(param && { param }) },
    }))
    this.code = code
  }
}

export function forwardResponseHeaders(c: Context, headers: Headers): void {
  for (const name of ["x-request-id", "x-codex-turn-state", "retry-after"]) {
    const value = headers.get(name)
    if (value !== null) c.header(name, value)
  }
}

/**
 * Extract structured error details from a caught error.
 * Used by every handler's request_end log to unify error reporting.
 */
export function extractErrorDetails(error: unknown): {
  errorDetail: string
  upstreamStatus: number | null
  statusCode: number
} {
  const errorMsg = error instanceof Error ? error.message : String(error)
  const upstreamStatus =
    error instanceof HTTPError ? error.status : null
  const statusCode = upstreamStatus ?? 502
  const body =
    error instanceof HTTPError ? error.responseBody : ""
  const errorDetail = body
    ? `${errorMsg}: ${body.slice(0, MAX_BODY_LENGTH)}`
    : errorMsg
  return { errorDetail, upstreamStatus, statusCode }
}

export async function forwardError(c: Context, error: unknown) {
  // Error details are already logged by the handler's request_end event.
  // This function only builds the HTTP response for the client.

  if (error instanceof HTTPError) {
    forwardResponseHeaders(c, error.headers)
    if (error.responseBody) {
      let body: unknown
      try {
        body = JSON.parse(error.responseBody)
      } catch (parseError) {
        if (!(parseError instanceof SyntaxError)) throw parseError
      }
      if (isRecord(body) && isRecord(body.error)) {
        return c.json(body, error.status as ContentfulStatusCode)
      }
    }
    return c.json(
      {
        error: {
          message: error.responseBody || error.message,
          type: "error",
        },
      },
      error.status as ContentfulStatusCode,
    )
  }

  return c.json(
    {
      error: {
        message: (error as Error).message,
        type: "error",
      },
    },
    500,
  )
}

import { Hono } from "hono"
import { handleCountTokens, handleMessages } from "./handler"

export const messageRoutes = new Hono()
messageRoutes.post("/", handleMessages)
messageRoutes.post("/count_tokens", handleCountTokens)

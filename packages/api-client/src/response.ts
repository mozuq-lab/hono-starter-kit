import { problemSchema } from "@starter/contracts";
import { ApiError, UnexpectedApiResponseError } from "./errors.js";

export const parsePayload = async (response: Response): Promise<unknown> => {
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = problemSchema.safeParse(payload);
    if (parsed.success) {
      throw new ApiError(parsed.data);
    }
    throw new UnexpectedApiResponseError(response.status);
  }
  return payload;
};

export const parseSuccess = <T>(
  payload: unknown,
  schema: {
    safeParse(input: unknown): { success: true; data: T } | { success: false };
  },
  status: number,
): T => {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new UnexpectedApiResponseError(status);
  }
  return parsed.data;
};

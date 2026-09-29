import { ProjectValidationError } from "./project.errors.js";

export const normalizeProjectName = (input: string): string => {
  const name = input.trim();
  if (name.length < 1) {
    throw new ProjectValidationError({
      name: ["Project name is required."],
    });
  }
  if (name.length > 100) {
    throw new ProjectValidationError({
      name: ["Project name must be 100 characters or fewer."],
    });
  }
  return name;
};

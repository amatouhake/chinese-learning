export type ClientDomainErrorCode =
  "invalid_input" | "reference_not_found" | "conflict" | "practice_contract_mismatch";

export abstract class ClientDomainError extends Error {
  abstract readonly code: ClientDomainErrorCode;
}

export class InvalidInputError extends ClientDomainError {
  readonly code = "invalid_input" as const;

  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}

export class ReferenceNotFoundError extends ClientDomainError {
  readonly code = "reference_not_found" as const;

  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`);
    this.name = "ReferenceNotFoundError";
  }
}

export class ConflictError extends ClientDomainError {
  readonly code: "conflict" | "practice_contract_mismatch" = "conflict";

  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class ConcurrencyConflictError extends ConflictError {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyConflictError";
  }
}

export class PracticeContractMismatchError extends ConflictError {
  readonly code = "practice_contract_mismatch" as const;

  constructor(message: string) {
    super(message);
    this.name = "PracticeContractMismatchError";
  }
}

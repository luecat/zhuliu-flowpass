export interface ModelCapabilities {
  id: string;
  contextLength: number | null;
  supportsJsonSchema: boolean | null;
  supportsChat: boolean | null;
}

export interface ModelCatalog {
  readonly selectedModelId: string | null;
  readonly models: readonly ModelCapabilities[];
}

/** Server-side model metadata only. It intentionally never performs a live request. */
export function createModelCatalog(models: readonly ModelCapabilities[], selectedModelId = process.env.FLOWPASS_MODEL_ID ?? null): ModelCatalog {
  return { models: models.map((model) => ({ ...model })), selectedModelId };
}

export function eligibleModel(model: ModelCapabilities): boolean {
  return model.contextLength !== null && model.contextLength >= 16_384 && model.supportsJsonSchema === true;
}

export function formatModelDoctorReport(catalog: ModelCatalog): string {
  return JSON.stringify({ selectedModelId: catalog.selectedModelId, models: catalog.models }, null, 2);
}

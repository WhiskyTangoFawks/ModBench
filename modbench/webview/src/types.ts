import type { components } from '../../src/wire/generated/api';

type Schemas = components['schemas'];

// The record editor's wire DTOs: every type here is the generated schema type.

export type FormKeyResolution = Schemas['FormKeyResolution'];
export type ConflictAll = Schemas['ConflictAll'];
export type ConflictThis = Schemas['ConflictThis'];
export type FieldMetadata = Schemas['FieldMetadata'];
export type FieldValue = Schemas['FieldValue'];
export type PluginLoadFailure = Schemas['PluginLoadFailure'];
export type CompareOverride = Schemas['CompareOverride'];
export type FieldDiff = Schemas['FieldDiff'];
export type CompareResult = Schemas['CompareResult'];

export type { ColumnKey } from '../../src/wire/columnKey';
export type { PathHop, PathSegment, RecordEditEnvelope } from '../../src/wire/messages';

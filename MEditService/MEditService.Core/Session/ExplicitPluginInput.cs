namespace MEditService.Core.Session;

/// <summary>
/// One entry of an explicit-session load order (#298): a scattered physical plugin path, the mod
/// origin it was resolved from, and whether it participates in winner computation. The domain
/// counterpart of <c>Queries.ExplicitPlugin</c> — that DTO's <c>Participates</c> is nullable so an
/// omitted JSON property is rejectable at the endpoint; this type is constructed only after that
/// validation has passed, so <c>Participates</c> is non-nullable here.
/// </summary>
public record ExplicitPluginInput(string Name, string Path, string Origin, bool Participates);

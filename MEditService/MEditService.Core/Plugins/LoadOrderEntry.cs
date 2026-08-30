namespace MEditService.Core.Plugins;

/// <summary>
/// One physical plugin copy in the snapshot Mod Management sends as <c>PUT /load-order</c>
/// (ADR-0044): where the file is, the mod origin it was resolved from, and the three facts its
/// registration carries — the name's <c>plugins.txt</c> slot (null when no line names it), the
/// line's <c>*</c> prefix, and whether the Mod override order resolves the name to this copy.
/// The domain counterpart of <c>Queries.LoadOrderPlugin</c> — that DTO's booleans are nullable so
/// an omitted JSON property is rejectable at the endpoint; this type is constructed only after
/// that validation has passed.
/// </summary>
public record LoadOrderEntry(string Name, string Path, string Origin, int? Slot, bool Enabled, bool Winning);

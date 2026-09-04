namespace MEditService.Core.Plugins;

/// <summary>The domain counterpart of <c>Queries.LoadOrderPlugin</c> (ADR-0044): that DTO's
/// booleans are nullable so an omitted JSON property is rejectable at the endpoint, and this type
/// is constructed only after that validation has passed.</summary>
public record LoadOrderEntry(string Name, string Path, string Origin, int? Slot, bool Enabled, bool Winning);

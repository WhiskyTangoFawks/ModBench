using MEditService.LoadOrder;

namespace MEditService.Index;

/// <summary>A link in <paramref name="Plugin"/>'s record <paramref name="FormKey"/> (an inline child
/// under its own) to <paramref name="TargetFormKey"/>, which no active plugin holds.</summary>
internal sealed record MissingReference(
    PluginAddress Plugin, string FormKey, string RecordType, string? EditorId, string TargetFormKey, string FieldPath);

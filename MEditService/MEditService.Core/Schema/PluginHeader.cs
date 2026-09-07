using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Schema;

/// <summary>The plugin's own ModHeader as a record type: the name every table and document keys it
/// by, and the synthetic FormKey it occupies.</summary>
internal static class PluginHeader
{
    internal const string RecordType = "header";

    /// <summary>The header's masters member, reflected as a read-only column: a write to it is refused
    /// (ADR-0038: masters are content-derived at compile time). Never a runtime branch; the missing
    /// delegate is the enforcement.</summary>
    internal const string MastersFieldName = "MasterReferences";

    /// <summary>The null form, which no major record can occupy.</summary>
    internal static string FormKeyFor(ModKey plugin) => FormKey.Factory($"000000:{plugin}").ToString();
}

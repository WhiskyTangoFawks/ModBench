using MEditService.PluginAdapter.Repair;

namespace MEditService.Commands.Edits;

/// <summary>How a refusal names a plugin's malformed records, and whether decompile and repair clears them.</summary>
internal static class Malformations
{
    internal static string Described(IEnumerable<RepairPreview> malformations) =>
        string.Join("; ", malformations.Select(malformation => malformation.Diagnosis.Describe()));

    internal static bool RepairClears(IReadOnlyList<RepairPreview> malformations) =>
        malformations.All(malformation => malformation.Change is not null);

    internal static string CannotBecomeSource(string pluginName, IReadOnlyList<RepairPreview> malformations) =>
        $"{pluginName} is a malformed plugin and cannot become source: {Described(malformations)}.";
}

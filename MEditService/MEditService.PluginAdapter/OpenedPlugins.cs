using System.Text;
using MEditService.LoadOrder;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.PluginAdapter;

/// <summary>What an already-opened plugin answers about its own records, shared by every
/// <see cref="IPluginAdapter"/> so the verbs cannot drift between implementations.</summary>
internal static class OpenedPlugins
{
    internal static (PluginContent Content, Exception? Unreachable) ContentIn(IModGetter mod, string pluginName)
    {
        var (recordCount, unreachable) = ReachableRecordCount(mod);
        return (
            new PluginContent(
                IsLight: PluginFlagPredicates.IsLight(mod, pluginName),
                IsMaster: PluginFlagPredicates.IsMaster(mod, pluginName),
                Masters: [.. mod.MasterReferences.Select(reference => reference.Master.FileName.ToString())],
                RecordCount: recordCount),
            unreachable);
    }

    // A group whose location scan Mutagen refuses stops the walk, and the count is a readout, not a
    // gate: the plugin reads on what was reachable and the ingest reports the type that was not.
    private static (int Count, Exception? Unreachable) ReachableRecordCount(IModGetter mod)
    {
        var count = 0;
        try
        {
            foreach (var _ in mod.EnumerateMajorRecords()) count++;
        }
        catch (Exception ex)
        {
            return (count, ex);
        }
        return (count, null);
    }

    internal static PluginFormIds FormIdsIn(IModGetter mod, string pluginName) =>
        new(Encoding.UTF8.GetString(HeaderDocument.Write(mod)),
            mod.EnumerateMajorRecords()
                .Select(record => record.FormKey)
                .Where(key => key.ModKey.FileName.String.Equals(pluginName, StringComparison.OrdinalIgnoreCase))
                .Select(key => key.ToString())
                .ToHashSet(StringComparer.OrdinalIgnoreCase));

    internal static bool LinksTo(IModGetter mod, string pluginName, FormKey target, FormKey? itself)
    {
        // A FormID indexes this copy's own master list, so a copy that does not master the target's
        // plugin cannot express a link to it — the header answers before the walk starts.
        var masters = mod.MasterReferences
            .Select(reference => reference.Master.FileName.String)
            .Append(pluginName)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (!masters.Contains(target.ModKey.FileName.String)) return false;

        foreach (var record in mod.EnumerateMajorRecords())
        {
            if (itself is { } self && record.FormKey == self) continue;
            if (record.EnumerateFormLinks().Any(link => link.FormKey == target)) return true;
        }
        return false;
    }
}

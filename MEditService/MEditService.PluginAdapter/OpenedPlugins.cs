using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.PluginAdapter;

/// <summary>What an already-opened plugin answers about its own records, shared by every
/// <see cref="IPluginAdapter"/> so the verbs cannot drift between implementations.</summary>
internal static class OpenedPlugins
{
    internal static (PluginContent Content, PluginFailure? Unreachable) ContentIn(
        IModGetter mod, string pluginName, bool isBlueprint)
    {
        var (recordCount, unreachable) = ReachableRecordCount(mod);
        return (
            new PluginContent(
                IsLight: PluginFlags.IsLight(mod, pluginName),
                IsMedium: PluginFlags.IsMedium(mod, pluginName),
                IsMaster: PluginFlags.IsMaster(mod, pluginName),
                IsBlueprint: isBlueprint,
                IsLocalized: mod.UsingLocalization,
                Masters: [.. mod.MasterReferences.Select(reference => reference.Master.FileName.ToString())],
                RecordCount: recordCount),
            unreachable);
    }

    // A group whose location scan Mutagen refuses stops the walk at the records reachable so far, and
    // the ingest reports the type that was not.
    private static (int Count, PluginFailure? Unreachable) ReachableRecordCount(IModGetter mod)
    {
        var count = 0;
        try
        {
            foreach (var _ in mod.EnumerateMajorRecords()) count++;
        }
        catch (Exception ex) when (OutOfMemoryOrCancellation.In(ex) is null)
        {
            return (count, PluginFailure.Of(ex));
        }
        return (count, null);
    }
}

using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Resolution;

/// <summary>What the load order says about a record (target-architecture.d2 medit_core.commands).
/// An internal module of Commands, tested through the gestures.</summary>
internal sealed class LoadOrderResolution(
    LoadOrderHolder loadOrder, IPluginAdapter adapter, RecordTextCodec codec, SchemaReflector schemaReflector)
{
    internal CopySource SourceOf(PluginAddress plugin) => SourceIn(loadOrder.Current, plugin);

    private CopySource SourceIn(LoadOrderSnapshot snapshot, PluginAddress plugin) =>
        new(plugin, snapshot, adapter, codec, schemaReflector);

    /// <summary>The walk to the left among the masters <paramref name="plugin"/>'s source tree requires,
    /// over the load order held now, whole. The tree is read on the first walk.</summary>
    internal MastersWalk WalkAmongMastersOf(
        SourceRepository repository, PluginAddress plugin, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        WalkIn(loadOrder.Current, repository, plugin, schemas);

    private MastersWalk WalkIn(
        LoadOrderSnapshot snapshot, SourceRepository repository, PluginAddress plugin,
        IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        new(this, snapshot, plugin, new Lazy<IReadOnlySet<string>>(() => RequiredMasters.InTheTree(repository, plugin, schemas)));

    /// <summary>The name of the plugin originating <paramref name="formKey"/> when <paramref name="destination"/>
    /// loads before it, so a copy there would be an underride. Null when it loads after, or either is not placed.</summary>
    internal string? OriginLoadingAfter(string formKey, PluginAddress destination)
    {
        var current = loadOrder.Current;

        // A FormKey carries only a filename, so with two plugins that share a filename (ADR-0012) the
        // active one is the origin.
        var originName = FormKey.Factory(formKey).ModKey.FileName.String;
        var origin = current.Active.FirstOrDefault(p => p.Name.Equals(originName, StringComparison.OrdinalIgnoreCase));
        var originIndex = origin is null ? null : current.LoadOrderIndex(origin.Key);
        var destinationIndex = current.LoadOrderIndex(destination);
        return originIndex is { } originAt && destinationIndex is { } destinationAt && destinationAt < originAt ? originName : null;
    }

    /// <summary>xEdit's HighestOverrideVisibleForFile: the source's copy stands unless it is Partial Form
    /// or a master of the destination loads after it. <paramref name="text"/> is that master's copy,
    /// null when the source's stands.</summary>
    internal RecordEditResult? HighestOverrideVisibleToTheDestination(
        CopySource source, RecordIdentity identity, SourceRepository destinationRepository, PluginAddress destinationPlugin,
        out string? text)
    {
        text = null;
        var snapshot = source.Snapshot;
        int IndexOf(PluginAddress plugin) => snapshot.LoadOrderIndex(plugin) ?? snapshot.Active.Count;
        var sourcePartial = source.IsPartialForm(identity);
        if (!sourcePartial && IndexOf(destinationPlugin) <= IndexOf(source.Plugin)) return null;

        var masters = WalkIn(snapshot, destinationRepository, destinationPlugin, schemaReflector.GetSchemas(snapshot.GameRelease));
        switch (masters.NearestCopy(identity.FormKey, _ => true, PartialFormFlag.Bit))
        {
            case LeftCopy.Unreadable unreadable:
                return unreadable.Refusal(identity.FormKey, "the copy of a container the destination can see is carried in");
            case LeftCopy.Found found when sourcePartial || IndexOf(found.Plugin) > IndexOf(source.Plugin):
                text = found.Text;
                return null;
            default:
                return null;
        }
    }

    /// <summary>Who holds the cell at <paramref name="grid"/>: the plugin, then its masters (xEdit's
    /// AllVisibleForFile, ADR-0018). A refusal is spelled at <paramref name="spelled"/>, naming <paramref name="subject"/>.</summary>
    internal GridCellHolder HolderOfCell(
        SourceRepository repository, PluginAddress plugin, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        string worldspace, (int X, int Y) grid, string spelled, string subject)
    {
        try
        {
            if (repository.GetCellAt(plugin, worldspace, grid.X, grid.Y, schemas) is { } held) return new GridCellHolder.Plugins(held);
            switch (WalkAmongMastersOf(repository, plugin, schemas).NearestCell(worldspace, grid.X, grid.Y))
            {
                case LeftCopy.Unreadable left:
                    return new GridCellHolder.Unreadable(
                        left.Refusal(spelled, $"{subject} is read from the nearest of {plugin.Name}'s masters"));
                case LeftCopy.Found found:
                    var formKey = GridCellHolder.FormKeyOf(JsonNode.Parse(found.Text) as JsonObject);
                    return repository.Get(plugin, formKey, schemas) is { } copy
                        ? new GridCellHolder.Plugins(copy)
                        : new GridCellHolder.Masters(found, formKey);
                default:
                    return new GridCellHolder.Nobody();
            }
        }
        catch (UnreadableSourceDocumentException ex)
        {
            return new GridCellHolder.Unreadable(RecordEditResult.RefusedAt(
                RecordEditRefusal.RecordParseFailed, spelled,
                $"'{spelled}': {subject} cannot be read: {ex.Message.TrimEnd('.')}. Nothing was written."));
        }
    }

    internal sealed class MastersWalk(
        LoadOrderResolution resolution, LoadOrderSnapshot snapshot, PluginAddress plugin, Lazy<IReadOnlySet<string>> masters)
    {
        /// <summary>The nearest master's copy of <paramref name="formKey"/> that <paramref name="says"/> accepts,
        /// passing over one whose header holds a flag of <paramref name="passOver"/>. An unreadable copy ends the walk.</summary>
        internal LeftCopy NearestCopy(string formKey, Func<JsonObject, bool> says, long passOver = 0) =>
            Walk(formKey, source =>
            {
                if (source.Identity(formKey) is not { } identity) return null;
                if (passOver != 0 && (source.RecordFlags(identity) & passOver) != 0) return null;
                var body = source.Body(identity);
                return JsonNode.Parse(body) is JsonObject copy && says(copy) ? body : null;
            });

        /// <summary>The nearest master's copy of the exterior cell at grid (<paramref name="x"/>, <paramref name="y"/>)
        /// of <paramref name="worldspace"/>.</summary>
        internal LeftCopy NearestCell(string worldspace, int x, int y) =>
            Walk(worldspace, source => source.CellAt(worldspace, x, y) is { } identity ? source.Body(identity) : null);

        // The plugins left of this one, nearest first, until one answers a text. An unreadable one ends the
        // walk, named by what it was asked about, as does a source tree that cannot say which are masters.
        private LeftCopy Walk(string askedAbout, Func<CopySource, string?> answer)
        {
            IReadOnlySet<string> required;
            try
            {
                required = masters.Value;
            }
            catch (UnreadableSourceDocumentException ex)
            {
                return new LeftCopy.Unreadable($"the source tree that names {plugin.Name}'s masters", ex.Message);
            }
            var index = snapshot.LoadOrderIndex(plugin) ?? snapshot.Active.Count;
            var asked = snapshot.Active.Take(index).Reverse().Select(registered => registered.Key)
                .Where(left => required.Contains(left.Name));
            foreach (var left in asked)
            {
                using var source = resolution.SourceIn(snapshot, left);
                try
                {
                    if (answer(source) is { } text) return new LeftCopy.Found(text, left);
                }
                catch (Exception ex) when (ex is not OutOfMemoryException)
                {
                    return new LeftCopy.Unreadable($"{left.Name}'s copy of {askedAbout}", source.Diagnose(ex));
                }
            }
            return new LeftCopy.None();
        }
    }
}

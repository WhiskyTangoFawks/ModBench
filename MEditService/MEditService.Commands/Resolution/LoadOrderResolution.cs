using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Resolution;

/// <summary>What the load order says about a record (target-architecture.d2 medit_core.commands).
/// An internal module of Commands, tested through the gestures.</summary>
internal sealed class LoadOrderResolution(
    LoadOrderHolder loadOrder, IPluginAdapter adapter, RecordTextCodec codec, SchemaReflector schemaReflector)
{
    internal CopySource SourceOf(PluginAddress plugin) =>
        new(plugin, loadOrder.Current, adapter, codec, schemaReflector);

    /// <summary>The masters <paramref name="plugin"/>'s source tree requires, or the refusal of a tree that
    /// cannot be read.</summary>
    internal static RecordEditResult? MastersOf(
        SourceRepository repository, PluginAddress plugin, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        string spelled, string readFromAMaster, out IReadOnlySet<string> masters)
    {
        masters = new HashSet<string>();
        try
        {
            masters = RequiredMasters.InTheTree(repository, plugin, schemas);
            return null;
        }
        catch (UnreadableSourceDocumentException ex)
        {
            return RecordEditResult.RefusedAt(
                RecordEditRefusal.RecordParseFailed, spelled,
                $"'{spelled}': {readFromAMaster} comes only from a master of {plugin.Name}, " +
                $"which its source tree names, and that tree cannot be read: {ex.Message.TrimEnd('.')}. Nothing was written.");
        }
    }

    /// <summary>xEdit's HighestOverrideVisibleForFile: the source's copy stands unless it is Partial Form
    /// or a master of the destination loads after it. <paramref name="text"/> is that master's copy,
    /// null when the source's stands.</summary>
    internal RecordEditResult? HighestOverrideVisibleToTheDestination(
        CopySource source, RecordIdentity identity, RecordCopy.Destination destination, out string? text)
    {
        text = null;
        var current = loadOrder.Current;
        int IndexOf(PluginAddress plugin) => current.LoadOrderIndex(plugin) ?? current.Active.Count;
        var sourcePartial = source.IsPartialForm(identity);
        if (!sourcePartial && IndexOf(destination.Plugin) <= IndexOf(source.Plugin)) return null;

        var spelled = identity.FormKey;
        if (MastersOf(
                destination.Repository, destination.Plugin, schemaReflector.GetSchemas(current.GameRelease), spelled,
                "the copy of a container the destination can see", out var masters) is { } refused) return refused;

        switch (NearestCopyToTheLeft(destination.Plugin, identity.FormKey, _ => true, PartialFormFlag.Bit, masters))
        {
            case LeftCopy.Unreadable unreadable:
                return unreadable.Refusal(spelled, "the copy of a container the destination can see is carried in");
            case LeftCopy.Found found when sourcePartial || IndexOf(found.Plugin) > IndexOf(source.Plugin):
                text = found.Text;
                return null;
            default:
                return null;
        }
    }

    /// <summary>The nearest copy left of <paramref name="plugin"/>, among <paramref name="among"/> if given,
    /// that <paramref name="says"/> accepts, passing over one whose header holds a flag of
    /// <paramref name="passOver"/>. An unreadable copy ends the walk.</summary>
    internal LeftCopy NearestCopyToTheLeft(
        PluginAddress plugin, string formKey, Func<JsonObject, bool> says, long passOver = 0, IReadOnlySet<string>? among = null) =>
        NearestToTheLeft(plugin, formKey, among, source =>
        {
            if (source.Identity(formKey) is not { } identity) return null;
            if (passOver != 0 && (source.RecordFlags(identity) & passOver) != 0) return null;
            var body = source.Body(identity);
            return JsonNode.Parse(body) is JsonObject copy && says(copy) ? body : null;
        });

    /// <summary>Who holds the cell at <paramref name="grid"/>: the plugin, then its masters (xEdit's
    /// AllVisibleForFile, ADR-0018). A refusal is spelled at <paramref name="spelled"/>, naming <paramref name="subject"/>.</summary>
    internal GridCellHolder HolderOfCell(
        SourceRepository repository, PluginAddress plugin, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        string worldspace, (int X, int Y) grid, string spelled, string subject)
    {
        try
        {
            if (repository.GetCellAt(plugin, worldspace, grid.X, grid.Y, schemas) is { } held) return new GridCellHolder.Plugins(held);
            if (MastersOf(repository, plugin, schemas, spelled, subject, out var masters) is { } unreadable)
                return new GridCellHolder.Unreadable(unreadable);
            switch (NearestCellToTheLeft(plugin, worldspace, grid.X, grid.Y, masters))
            {
                case LeftCopy.Unreadable left:
                    return new GridCellHolder.Unreadable(
                        left.Refusal(spelled, $"{subject} is read from the nearest of {plugin.Name}'s masters"));
                case LeftCopy.Found found:
                    var formKey = GridCells.FormKeyOf(JsonNode.Parse(found.Text) as JsonObject);
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

    private LeftCopy NearestCellToTheLeft(PluginAddress plugin, string worldspace, int x, int y, IReadOnlySet<string> among) =>
        NearestToTheLeft(plugin, worldspace, among, source =>
            source.CellAt(worldspace, x, y) is { } identity ? source.Body(identity) : null);

    // The plugins left of this one, nearest first, until one answers a text. An unreadable one ends the
    // walk, named by what it was asked about.
    private LeftCopy NearestToTheLeft(
        PluginAddress plugin, string askedAbout, IReadOnlySet<string>? among, Func<CopySource, string?> answer)
    {
        var current = loadOrder.Current;
        var index = current.LoadOrderIndex(plugin) ?? current.Active.Count;
        var asked = current.Active.Take(index).Reverse().Select(registered => registered.Key)
            .Where(left => among?.Contains(left.Name) ?? true);
        foreach (var left in asked)
        {
            using var source = SourceOf(left);
            try
            {
                if (answer(source) is { } text) return new LeftCopy.Found(text, left);
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                return new LeftCopy.Unreadable(left.Name, askedAbout, source.Diagnose(ex));
            }
        }
        return new LeftCopy.None();
    }
}

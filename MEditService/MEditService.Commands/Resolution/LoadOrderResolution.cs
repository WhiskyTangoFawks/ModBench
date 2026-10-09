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
    LoadOrderHolder loadOrder, IPluginAdapter adapter, SchemaReflector schemaReflector)
{
    internal CopySource SourceOf(PluginAddress plugin, UnsavedBatches batches) => SourceIn(loadOrder.Current, plugin, batches);

    private CopySource SourceIn(LoadOrderSnapshot snapshot, PluginAddress plugin, UnsavedBatches batches) =>
        new(plugin, snapshot, adapter, schemaReflector, batches);

    /// <summary>The walk to the left among the masters <paramref name="plugin"/>'s source tree requires,
    /// over the load order held now, whole, each master read over <paramref name="batches"/>.</summary>
    internal MastersWalk WalkAmongMastersOf(
        SourceRepository repository, PluginAddress plugin, IReadOnlyDictionary<string, RecordTableSchema> schemas, UnsavedBatches batches) =>
        WalkIn(loadOrder.Current, repository, plugin, schemas, batches);

    private MastersWalk WalkIn(
        LoadOrderSnapshot snapshot, SourceRepository repository, PluginAddress plugin,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, UnsavedBatches batches) =>
        new(this, snapshot, plugin, batches, new Lazy<SourceAnswer<IReadOnlySet<string>>>(() => RequiredMasters.InTheTree(repository, plugin, schemas)));

    /// <summary>The first master the copy needs that <paramref name="destination"/> loads before, an underride:
    /// its origin, then each plugin holding a record <paramref name="body"/> references (ADR-0008; xEdit).</summary>
    internal string? MasterLoadingAfter(RecordIdentity identity, string body, PluginAddress destination)
    {
        var current = loadOrder.Current;
        var required = new RequiredMasters(destination);
        required.Add(new PluginDocument(identity.RecordType, identity.FormKey, body), schemaReflector.GetSchemas(current.GameRelease)[identity.RecordType]);
        var originName = RequiredMasters.PluginNameIn(identity.FormKey);
        return required.Masters
            .OrderBy(master => !master.Equals(originName, StringComparison.OrdinalIgnoreCase))
            .FirstOrDefault(master => LoadsBeforeThePluginNamed(current, destination, master));
    }

    // A FormKey carries only a filename, and every plugin of that filename shares its line (ADR-0012).
    private static bool LoadsBeforeThePluginNamed(LoadOrderSnapshot snapshot, PluginAddress plugin, string name) =>
        snapshot.Plugins.Where(named => named.Name.Equals(name, StringComparison.OrdinalIgnoreCase))
            .Select(named => snapshot.LoadsBefore(plugin, named.Key)).FirstOrDefault(loadsBefore => loadsBefore is not null) == true;

    /// <summary>xEdit's HighestOverrideVisibleForFile: the source's copy stands unless it is Partial Form
    /// or a master of the destination loads after it. <paramref name="text"/> is that master's copy,
    /// null when the source's stands.</summary>
    internal RecordEditResult? HighestOverrideVisibleToTheDestination(
        CopySource source, RecordIdentity identity, SourceRepository destinationRepository, PluginAddress destinationPlugin,
        out string? text)
    {
        text = null;
        var snapshot = source.Snapshot;
        if (!source.IsPartialForm(identity).Holds(out var sourcePartial, out var why))
            return WriteTargets.RefuseUnreadableSource(identity.FormKey, why);
        if (!sourcePartial && snapshot.LoadsBefore(source.Plugin, destinationPlugin) != true) return null;

        var masters = WalkIn(
            snapshot, destinationRepository, destinationPlugin, schemaReflector.GetSchemas(snapshot.GameRelease), source.Batches);
        switch (masters.NearestCopy(identity.FormKey, _ => true, PartialFormFlag.Bit))
        {
            case LeftCopy.Unreadable unreadable:
                return unreadable.Refusal(identity.FormKey, "the copy of a container the destination can see is carried in");
            case LeftCopy.Found found when sourcePartial || snapshot.LoadsBefore(source.Plugin, found.Plugin) == true:
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
        string worldspace, (int X, int Y) grid, string spelled, string subject, UnsavedBatches batches)
    {
        if (!repository.GetCellAt(plugin, worldspace, grid.X, grid.Y).Holds(out var held, out var failure))
            return Unreadable(failure);
        if (held is not null) return new GridCellHolder.Plugins(held);
        switch (WalkAmongMastersOf(repository, plugin, schemas, batches).NearestCell(worldspace, grid.X, grid.Y))
        {
            case LeftCopy.Unreadable left:
                return new GridCellHolder.Unreadable(
                    left.Refusal(spelled, $"{subject} is read from the nearest of {plugin.Name}'s masters"));
            case LeftCopy.Found found:
                var formKey = GridCellHolder.FormKeyOf(JsonNode.Parse(found.Text) as JsonObject);
                if (!repository.Get(plugin, formKey).Holds(out var copy, out failure)) return Unreadable(failure);
                return copy is not null ? new GridCellHolder.Plugins(copy) : new GridCellHolder.Masters(found, formKey);
            default:
                return new GridCellHolder.Nobody();
        }

        GridCellHolder Unreadable(SourceFailure unread) =>
            new GridCellHolder.Unreadable(RecordEditResult.RefusedAt(
                WriteFailure.KindOf(unread), spelled,
                $"'{spelled}': {subject} cannot be read: {unread.Reason.TrimEnd('.')}. Nothing was written."));
    }

    internal sealed class MastersWalk(
        LoadOrderResolution resolution, LoadOrderSnapshot snapshot, PluginAddress plugin, UnsavedBatches batches, Lazy<SourceAnswer<IReadOnlySet<string>>> masters)
    {
        /// <summary>The nearest master's copy of <paramref name="formKey"/> that <paramref name="says"/> accepts,
        /// passing over one whose header holds a flag of <paramref name="passOver"/>. An unreadable copy ends the walk.</summary>
        internal LeftCopy NearestCopy(string formKey, Func<JsonObject, bool> says, long passOver = 0) =>
            Walk(formKey, source => source.Identity(formKey).Then<string?>(held =>
            {
                if (held is not { } identity) return (string?)null;
                return source.RecordFlags(identity).Then<string?>(flags =>
                    passOver != 0 && (flags & passOver) != 0
                        ? (string?)null
                        : source.Body(identity).Then<string?>(body => JsonNode.Parse(body) is JsonObject copy && says(copy) ? body : null));
            }));

        /// <summary>The copy saying where <paramref name="cell"/> sits is its own, else its nearest copy to the left
        /// (xEdit's highest override). A refusal when the walk cannot read, <paramref name="unsaid"/> when none says.</summary>
        internal RecordEditResult? WhereItSits(
            JsonObject cell, string spelled, string needs, Func<RecordEditResult> unsaid, out JsonObject said)
        {
            said = cell;
            if (PlacedCell.Says(cell)) return null;
            var copy = cell[RecordMembers.FormKey]?.GetValue<string>() is { } formKey ? NearestCopy(formKey, PlacedCell.Says) : null;
            if (copy is LeftCopy.Unreadable unreadable) return unreadable.Refusal(spelled, needs);
            if (PlacedCell.SaidBy(cell, copy?.FoundText) is not { } found) return unsaid();
            said = found;
            return null;
        }

        /// <summary>The nearest master's copy of the exterior cell at grid (<paramref name="x"/>, <paramref name="y"/>)
        /// of <paramref name="worldspace"/>.</summary>
        internal LeftCopy NearestCell(string worldspace, int x, int y) =>
            Walk(worldspace, source => source.CellAt(worldspace, x, y).Then<string?>(held =>
                held is { } identity ? source.Body(identity).Then<string?>(body => body) : (string?)null));

        // The plugins left of this one, nearest first, until one answers a text. An unreadable one ends the
        // walk, named by what it was asked about, as does a source tree that cannot say which are masters.
        private LeftCopy Walk(string askedAbout, Func<CopySource, CopyRead<string?>> answer)
        {
            if (!masters.Value.Holds(out var required, out var unread))
                return new LeftCopy.UnreadableMastersTree(plugin, unread.Reason, WriteFailure.KindOf(unread));
            // With no line no judgement applies, so every judged master is to its left (commands.md § Principles).
            var asked = snapshot.JudgedCopies().Where(copy => snapshot.LoadsBefore(copy.Key, plugin) != false)
                .Reverse().Select(registered => registered.Key)
                .Where(left => required.Contains(left.Name));
            foreach (var left in asked)
            {
                using var source = resolution.SourceIn(snapshot, left, batches);
                if (!answer(source).Holds(out var text, out var why)) return new LeftCopy.UnreadableCopy(left, askedAbout, why.Why, why.Kind);
                if (text is not null) return new LeftCopy.Found(text, left);
            }
            return new LeftCopy.None();
        }
    }
}

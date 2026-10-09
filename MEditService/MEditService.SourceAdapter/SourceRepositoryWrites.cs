using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>The changes a transaction is made of, put, remove and rekey, each by identity; and the
/// write made directly, the whole-plugin replacement. Every write forgets what the locator remembered of the tree.</summary>
internal sealed class SourceRepositoryWrites(
    string modFolder, GameRelease release, SourceRepositoryLocator locator, SourceRepositoryLayout layout, SourceRepositoryGit git,
    ISourceFiles files)
{
    private readonly string _modFolder = modFolder;
    private readonly GameRelease _release = release;

    internal static CellPlacement PlacementIn(string worldspace, SourceDocument cell) =>
        JsonNode.Parse(cell.Body) is JsonObject document && PlacedCell.Grid(document) is var (x, y)
            ? CellPlacement.AtGrid(worldspace, x, y)
            : throw new InvalidOperationException(
                $"{cell.FormKey}'s document carries no grid, so it has no place in worldspace {worldspace}.");

    /// <summary>What removing a record changes: its embedded child cut from its owner's document, its
    /// directory-per-record container's folder, or its file.</summary>
    internal SourceChanges ChangesToRemove(PluginAddress plugin, RecordIdentity identity)
    {
        if (locator.Locate(plugin, identity) is not { } unit)
        {
            throw SourceStopException.NotCarried(
                $"No document in {plugin.Name}'s tree holds {identity.FormKey}. {SourceFailure.NotCarried.DefectOrOutsideChange}");
        }

        if (unit.IsEmbedded)
        {
            var ownerBytes = OwnerBytes(unit);
            return DocumentText.EmbeddedChildIn(ownerBytes, unit, identity.FormKey, _release) is { } span
                ? Written(unit.FullPath, EmbeddedChildSplice.Cut(ownerBytes, span))
                : throw NoLongerCarried(unit, identity.FormKey);
        }

        var path = unit.IsDirectoryPerRecord ? PathShape.DirectoryOf(unit.FullPath) : unit.FullPath;
        return new SourceChanges([], [Path.GetRelativePath(_modFolder, path)], []);
    }

    /// <summary>What putting a document changes: a held one's as <see cref="ChangesToRewrite"/> says, a new one's
    /// document and each block level the tree lacks above it.</summary>
    internal SourceChanges ChangesToPut(PluginAddress plugin, SourceDocument document)
    {
        RefuseOverwritingWhatIsNoDocument(plugin, document);
        return locator.LocateToPlace(plugin, document.Identity) is { } unit
            ? ChangesToHeld(unit, document)
            : ChangesToPlace(plugin, document, placement: null);
    }

    /// <summary>What putting an exterior cell changes: a held cell's as <see cref="ChangesToRewrite"/> says, a new
    /// one's at the block its grid falls in.</summary>
    internal SourceChanges ChangesToPutInWorldspace(PluginAddress plugin, SourceDocument cell, string worldspace)
    {
        RefuseOverwritingWhatIsNoDocument(plugin, cell);
        return locator.LocateToPlace(plugin, cell.Identity) is { } unit
            ? ChangesToHeld(unit, cell)
            : ChangesToPlace(plugin, cell, PlacementIn(worldspace, cell));
    }

    /// <summary>What putting a new child at the end of <paramref name="slot"/> of <paramref name="container"/>
    /// changes: the container's own text with the child appended, rewritten as <see cref="ChangesToRewrite"/> says.</summary>
    internal SourceChanges ChangesToPutChild(PluginAddress plugin, RecordIdentity container, string slot, SourceDocument child)
    {
        var unit = locator.Locate(plugin, container) is { } held && (held.IsEmbedded || files.FileExists(held.FullPath))
            ? held
            : throw SourceStopException.NotCarried(
                $"No document in {plugin.Name}'s tree holds {container.FormKey}, so there is no slot to put a child in. " +
                SourceFailure.NotCarried.MovedOrRemovedOutside);
        var containerText = DocumentText.RecordBodyFromOwnerBytes(OwnerBytes(unit), unit, container.FormKey, _release)
            ?? throw NoLongerCarried(unit, container.FormKey);
        var withChild = Read(() => ContainerDocumentEdits.WithChildAppended(
                containerText, _release, container.RecordType, container.FormKey, slot, child.Body, child.RecordType))
            ?? throw NoLongerCarried(unit, container.FormKey);
        return ChangesToHeld(unit, new SourceDocument(container.FormKey, container.RecordType, container.EditorId, withChild));
    }

    /// <summary>What rewriting a document the tree holds changes: its text, inside its owner's when embedded, and
    /// the move to its leaf name. One no document holds throws, since an edit never creates.</summary>
    internal SourceChanges ChangesToRewrite(PluginAddress plugin, SourceDocument document) =>
        locator.LocateToPlace(plugin, document.Identity) is { } unit && (unit.IsEmbedded || files.FileExists(unit.FullPath))
            ? ChangesToHeld(unit, document)
            : throw SourceStopException.NotCarried(
                $"No document in {plugin.Name}'s tree holds {document.FormKey}, so there is none to rewrite. " +
                SourceFailure.NotCarried.MovedOrRemovedOutside);

    private SourceChanges ChangesToPlace(PluginAddress plugin, SourceDocument document, CellPlacement? placement)
    {
        var (levels, placed) = layout.PlaceNewDocument(plugin, document.Identity, placement)
            ?? throw NoPlaceInTheTree(plugin, document.Identity);
        return new SourceChanges([], [], [.. levels, Document(placed.FullPath, document.Body)]);
    }

    private SourceChanges ChangesToHeld(SourceUnit unit, SourceDocument document)
    {
        if (!unit.IsEmbedded) return Planned(LeafPlan(unit, document), document.Body);

        var ownerBytes = OwnerBytes(unit);
        if (DocumentText.EmbeddedChildIn(ownerBytes, unit, document.FormKey, _release) is not { } span)
            throw NoLongerCarried(unit, document.FormKey);
        return Written(unit.FullPath, EmbeddedChildSplice.Replace(ownerBytes, span, document.Body));
    }

    // A file whose text is not a document is something else's, and writing over it drops what it wrote.
    private void RefuseOverwritingWhatIsNoDocument(PluginAddress plugin, SourceDocument document)
    {
        if (document.RecordType == PluginHeader.RecordType
            || locator.LocateToPlace(plugin, document.Identity) is not { IsEmbedded: false } unit
            || !files.FileExists(unit.FullPath))
            return;
        if (SourceRepositoryLocator.NotADocument(files.ReadAllText(unit.FullPath)) is { } why)
            throw SourceStopException.Unreadable($"{unit.RelativePath} is not a readable document, so its name cannot be checked: {why}");
    }

    /// <summary>What changing <paramref name="identity"/>'s FormKey changes, read from the text of the document
    /// <paramref name="carrying"/> it: its own file or folder moves to the new leaf name, or its owner's text changes.</summary>
    internal SourceChanges ChangesToRekey(
        PluginAddress plugin, SourceDocument carrying, RecordIdentity identity, string newFormKey)
    {
        var unit = locator.Locate(plugin, identity)
            ?? throw new InvalidOperationException($"No document in {plugin.Name}'s tree carries {identity.FormKey}.");

        if (!carrying.FormKey.Equals(identity.FormKey, StringComparison.Ordinal))
        {
            var ownerText = Read(() => RecordDocumentEdits.WithEmbeddedChildFormKey(
                    carrying.Body, _release, carrying.RecordType, identity.FormKey, newFormKey))
                ?? throw NoLongerCarried(unit, identity.FormKey);
            return Written(unit.FullPath, ownerText);
        }

        var text = Read(() => RecordDocumentEdits.WithFormKey(carrying.Body, _release, carrying.RecordType, newFormKey));
        if (unit.IsDirectoryPerRecord)
        {
            var from = PathShape.DirectoryOf(unit.FullPath);
            var to = Path.Combine(
                PathShape.DirectoryOf(from), SourceRepositoryLayout.LeafNameFor(FormKey.Factory(newFormKey), identity.EditorId, isDirectory: true));
            if (files.DirectoryExists(to) || files.FileExists(to))
            {
                throw new IOException(
                    $"{Path.GetFileName(to)} already exists in {Path.GetDirectoryName(to)}, so the container whose FormID changed " +
                    "has nowhere to move to.");
            }
            return Planned(ContainerPlan(unit, to), text);
        }

        var placed = layout.PlaceNewDocument(plugin, identity with { FormKey = newFormKey }, placement: null)?.Unit
            ?? throw NoPlaceInTheTree(plugin, identity);
        return new SourceChanges([Moved(unit.FullPath, placed.FullPath)], [], [Document(placed.FullPath, text)]);
    }

    // The codec is the one reader that sees why a text it is given is no record, and it says so by throwing
    // in Mutagen's open-ended ways.
    private static T Read<T>(Func<T> read)
    {
        try
        {
            return read();
        }
        catch (ChildSlotHeldByAnotherRecordException ex)
        {
            throw SourceStopException.Of(new SourceFailure.SlotHeld(ex.Message), ex);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            throw SourceStopException.Unreadable(ex.Message);
        }
    }

    private SourceChanges Planned(LeafMoves plan, string text) =>
        new([.. plan.Moves.Select(move => Moved(move.From, move.To))], [], [Document(plan.Written, text)]);

    private SourceChanges Written(string fullPath, string text) => new([], [], [Document(fullPath, text)]);

    private SourceMove Moved(string from, string to) =>
        new(Path.GetRelativePath(_modFolder, from), Path.GetRelativePath(_modFolder, to));

    private DocumentChange Document(string fullPath, string text) => new(Path.GetRelativePath(_modFolder, fullPath), text);

    internal void ReplaceSourceFrom(string pluginFileName, IReadOnlyList<TreeFile> files, string binarySha256)
    {
        // A mod folder another tool removed is not written back into being.
        if (!SourceRepositoryGit.IsTracked(_modFolder))
            throw SourceStopException.Inaccessible($"'{_modFolder}' holds no repository, so {pluginFileName}'s source has nowhere to go.");

        var root = SourceRepositoryLayout.RootIn(_modFolder, pluginFileName);
        var journal = new WriteJournal(_modFolder);
        try
        {
            var incoming = files.ToDictionary(file => Path.GetFullPath(Path.Combine(_modFolder, file.RelativePath)));
            var held = Directory.Exists(root)
                ? Directory.GetFiles(root, "*", SearchOption.AllDirectories)
                    .ToDictionary(Path.GetFullPath, File.ReadAllBytes)
                : [];
            foreach (var (path, bytes) in held.Where(file => !incoming.ContainsKey(file.Key))) journal.DeleteIfHolds(path, bytes);
            journal.DeleteEmptyDirectories(root);
            journal.WriteAll(
                incoming.Where(file => !held.TryGetValue(file.Key, out var bytes) || !bytes.AsSpan().SequenceEqual(file.Value.Content))
                    .Select(file => file.Value),
                _modFolder);
            git.ParkDecompiled(pluginFileName, binarySha256);
        }
        catch (Exception cause) when (cause is not OutOfMemoryException)
        {
            if (journal.Report(cause, journal.UndoSince(0)) is { } report) throw report;
            throw;
        }
        finally
        {
            locator.Forget();
        }
    }

    internal void RenameSource(string from, string to)
    {
        var fromRoot = SourceRepositoryLayout.RootIn(_modFolder, from);
        var held = Directory.GetFiles(fromRoot, "*", SearchOption.AllDirectories)
            .Order(StringComparer.Ordinal)
            .Select(path => (Path: path, Bytes: File.ReadAllBytes(path)))
            .ToList();
        var renamed = held
            .Select(file => PluginSourceRename.Renamed(Path.GetRelativePath(_modFolder, file.Path), file.Bytes, from, to))
            .ToList();

        var journal = new WriteJournal(_modFolder);
        try
        {
            journal.RecordUndo(git.LastWrittenPutBack(from, to), description: $"what Modbench last wrote for {from}");
            journal.WriteAll(renamed, _modFolder);
            git.MoveLastWritten(from, to);
            foreach (var file in held) journal.DeleteIfHolds(file.Path, file.Bytes);
            journal.DeleteEmptyDirectories(fromRoot);
        }
        catch (Exception cause) when (cause is not OutOfMemoryException)
        {
            if (journal.Report(cause, journal.UndoSince(0)) is { } report) throw report;
            throw;
        }
        finally
        {
            locator.Forget();
        }
    }

    private readonly record struct LeafMoves(IReadOnlyList<(string From, string To)> Moves, string Written);

    // The moves, in order, that put the document where its layout leaf name does, and where it is written
    // then; none when it is already there.
    private LeafMoves LeafPlan(SourceUnit unit, SourceDocument document)
    {
        if (document.RecordType == PluginHeader.RecordType || unit.IsEmbedded || !files.FileExists(unit.FullPath))
            return new LeafMoves([], unit.FullPath);

        var formKey = FormKey.Factory(document.FormKey);
        if (unit.IsDirectoryPerRecord)
        {
            return ContainerPlan(unit, Path.Combine(
                PathShape.DirectoryOf(PathShape.DirectoryOf(unit.FullPath)),
                SourceRepositoryLayout.LeafNameFor(formKey, document.EditorId, isDirectory: true)));
        }

        var to = Path.Combine(PathShape.DirectoryOf(unit.FullPath), SourceRepositoryLayout.FileNameFor(formKey, document.EditorId));
        return new LeafMoves(Differing([(unit.FullPath, to)]), to);
    }

    // The directory moves to where its leaf name puts it, then the document in it takes the leaf's name.
    private static LeafMoves ContainerPlan(SourceUnit unit, string toDirectory)
    {
        var written = SourceRepositoryLayout.ContainerDocumentIn(toDirectory);
        return new LeafMoves(
            Differing([
                (PathShape.DirectoryOf(unit.FullPath), toDirectory),
                (Path.Combine(toDirectory, Path.GetFileName(unit.FullPath)), written)]),
            written);
    }

    private static List<(string From, string To)> Differing(IEnumerable<(string From, string To)> moves) =>
        [.. moves.Where(move => !string.Equals(move.From, move.To, StringComparison.Ordinal))];

    private byte[] OwnerBytes(SourceUnit unit) => DocumentText.StripUtf8Bom(files.ReadAllBytes(unit.FullPath));

    private static InvalidOperationException NoPlaceInTheTree(PluginAddress plugin, RecordIdentity identity) =>
        new($"No document in {plugin.Name}'s tree holds {identity.FormKey}, and its type has no file of " +
            "its own, so there is nowhere to write it.");

    private static SourceStopException NoLongerCarried(SourceUnit unit, string formKey) =>
        SourceStopException.NotCarried(SourceFailure.NotCarried.FoundButNotCarried(unit.RelativePath, formKey));
}

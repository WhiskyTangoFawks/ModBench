using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>How the text of a document changes under a new FormKey: a record's own, or an embedded
/// child inside its owner's (null when the owner does not carry it).</summary>
public sealed record DocumentRekey(
    Func<SourceDocument, string, string> Own, Func<SourceDocument, string, string, string?> ChildOfOwner);

/// <summary>The writes a transaction is made of: put, remove and move, each by identity, and the
/// whole-plugin replacement. Every write forgets what the locator remembered of the tree.</summary>
internal sealed class SourceRepositoryWrites(
    string modFolder, GameRelease release, SourceRepositoryLocator locator, SourceRepositoryLayout layout, SourceRepositoryGit git)
{
    private readonly string _modFolder = modFolder;
    private readonly GameRelease _release = release;

    internal void Put(PluginAddress plugin, SourceDocument document, CellPlacement? placement)
    {
        var identity = new RecordIdentity(document.FormKey, document.RecordType, document.EditorId);
        if (locator.LocateToPlace(plugin, identity) is { } held) MoveToItsLeafName(held, document);
        var unit = locator.LocateToPlace(plugin, identity)
                   ?? layout.PlaceNewDocument(plugin, identity, placement)
                   ?? throw NoPlaceInTheTree(plugin, identity);

        if (unit.IsEmbedded)
        {
            var ownerBytes = OwnerBytes(unit);
            if (DocumentText.EmbeddedChildIn(ownerBytes, unit, document.FormKey, _release) is not { } span)
                throw NoLongerCarried(unit, document.FormKey);

            SourceRepositoryLayout.WriteTextAtomic(unit.FullPath, EmbeddedChildSplice.Replace(ownerBytes, span, document.Body));
            locator.Forget();
            return;
        }

        SourceRepositoryLayout.InMintedDirectory(
            PathShape.DirectoryOf(unit.FullPath), () => SourceRepositoryLayout.WriteTextAtomic(unit.FullPath, document.Body));
        locator.Forget();
    }

    internal static CellPlacement PlacementIn(string worldspace, SourceDocument cell) =>
        JsonNode.Parse(cell.Body) is JsonObject document && PlacedCell.Grid(document) is var (x, y)
            ? CellPlacement.AtGrid(worldspace, x, y)
            : throw new InvalidOperationException(
                $"{cell.FormKey}'s document carries no grid, so it has no place in worldspace {worldspace}.");

    internal SourceRemoval Remove(PluginAddress plugin, RecordIdentity identity)
    {
        if (locator.Locate(plugin, identity) is not { } unit) return SourceRemoval.NoDocumentHoldsIt;

        if (unit.IsEmbedded)
        {
            var ownerBytes = OwnerBytes(unit);
            if (DocumentText.EmbeddedChildIn(ownerBytes, unit, identity.FormKey, _release) is not { } span)
                return SourceRemoval.OwnerDoesNotCarryIt;

            SourceRepositoryLayout.WriteTextAtomic(unit.FullPath, EmbeddedChildSplice.Cut(ownerBytes, span));
            locator.Forget();
            return SourceRemoval.Removed;
        }

        if (unit.IsDirectoryPerRecord)
        {
            var directory = PathShape.DirectoryOf(unit.FullPath);
            if (Directory.Exists(directory)) DeleteWholeOrNotAtAll(directory);
            locator.Forget();
            return SourceRemoval.Removed;
        }

        if (File.Exists(unit.FullPath)) File.Delete(unit.FullPath);
        locator.Forget();
        return SourceRemoval.Removed;
    }

    /// <summary>What putting a document the tree holds whole changes: its text, and the move of its file
    /// or folder when its EditorID gives it another leaf name.</summary>
    internal SourceChanges ChangesToPut(PluginAddress plugin, SourceDocument document)
    {
        if (locator.LocateToPlace(plugin, document.Identity) is not { IsEmbedded: false } unit)
            throw NoPlaceInTheTree(plugin, document.Identity);

        if (LeafMove(unit, document) is not var (from, to)) return Written(unit.FullPath, document.Body);

        return unit.IsDirectoryPerRecord
            ? ContainerMoved(unit, to, document.Body)
            : new SourceChanges([Moved(from, to)], [Document(to, document.Body)]);
    }

    /// <summary>What putting an exterior cell at its grid changes: a held cell as <see cref="ChangesToPut"/>
    /// says, else its document and each block level the tree lacks.</summary>
    internal SourceChanges ChangesToPutInWorldspace(PluginAddress plugin, SourceDocument cell, string worldspace)
    {
        if (locator.LocateToPlace(plugin, cell.Identity) is not null) return ChangesToPut(plugin, cell);

        var (levels, cellPath) = layout.ExteriorCellDocuments(plugin, cell.Identity, PlacementIn(worldspace, cell));
        return new SourceChanges([], [.. levels.Select(level => Document(level.Path, level.Text)), Document(cellPath, cell.Body)]);
    }

    /// <summary>What changing <paramref name="identity"/>'s FormKey changes, read from the text of the document
    /// <paramref name="carrying"/> it: its own file or folder moves to the new leaf name, or its owner's text changes.</summary>
    internal SourceChanges ChangesToRekey(
        PluginAddress plugin, SourceDocument carrying, RecordIdentity identity, string newFormKey, DocumentRekey rekey)
    {
        var unit = locator.Locate(plugin, identity)
            ?? throw new InvalidOperationException($"No document in {plugin.Name}'s tree carries {identity.FormKey}.");

        if (!carrying.FormKey.Equals(identity.FormKey, StringComparison.Ordinal))
        {
            var ownerText = rekey.ChildOfOwner(carrying, identity.FormKey, newFormKey) ?? throw NoLongerCarried(unit, identity.FormKey);
            return Written(unit.FullPath, ownerText);
        }

        var text = rekey.Own(carrying, newFormKey);
        if (unit.IsDirectoryPerRecord)
        {
            var from = PathShape.DirectoryOf(unit.FullPath);
            var to = Path.Combine(
                PathShape.DirectoryOf(from), SourceRepositoryLayout.LeafNameFor(FormKey.Factory(newFormKey), identity.EditorId, isDirectory: true));
            if (Directory.Exists(to) || File.Exists(to))
            {
                throw new IOException(
                    $"{Path.GetFileName(to)} already exists in {Path.GetDirectoryName(to)}, so the container whose FormID changed " +
                    "has nowhere to move to.");
            }
            return ContainerMoved(unit, to, text);
        }

        var placed = layout.PlaceNewDocument(plugin, identity with { FormKey = newFormKey }, placement: null)
            ?? throw NoPlaceInTheTree(plugin, identity);
        return new SourceChanges([Moved(unit.FullPath, placed.FullPath)], [Document(placed.FullPath, text)]);
    }

    // The container's directory moves, and its document takes the new leaf's name inside it.
    private SourceChanges ContainerMoved(SourceUnit unit, string toDirectory, string text)
    {
        var document = SourceRepositoryLayout.ContainerDocumentIn(toDirectory);
        return new SourceChanges(
            [Moved(PathShape.DirectoryOf(unit.FullPath), toDirectory), Moved(Path.Combine(toDirectory, Path.GetFileName(unit.FullPath)), document)],
            [Document(document, text)]);
    }

    private SourceChanges Written(string fullPath, string text) => new([], [Document(fullPath, text)]);

    private SourceMove Moved(string from, string to) =>
        new(Path.GetRelativePath(_modFolder, from), Path.GetRelativePath(_modFolder, to));

    private DocumentChange Document(string fullPath, string text) => new(Path.GetRelativePath(_modFolder, fullPath), text);

    internal void ReplaceSourceFrom(string pluginFileName, IReadOnlyList<TreeFile> files, string binarySha256)
    {
        // A mod folder another tool removed is not written back into being.
        if (!SourceRepositoryGit.IsTracked(_modFolder))
            throw new InvalidOperationException($"'{_modFolder}' holds no repository, so {pluginFileName}'s source has nowhere to go.");

        var root = SourceRepositoryLayout.RootIn(_modFolder, pluginFileName);
        var before = Directory.Exists(root) ? PreImageOf(root) : new PreImage([], []);
        try
        {
            var incoming = files.ToDictionary(file => Path.GetFullPath(Path.Combine(_modFolder, file.RelativePath)));
            var held = before.Files.ToDictionary(file => Path.GetFullPath(file.Path), file => file.Bytes);
            foreach (var path in held.Keys.Where(path => !incoming.ContainsKey(path))) File.Delete(path);
            DeleteEmptyDirectories(root);
            PristineFileWriter.WriteAll(
                incoming.Where(file => !held.TryGetValue(file.Key, out var bytes) || !bytes.AsSpan().SequenceEqual(file.Value.Content))
                    .Select(file => file.Value),
                _modFolder);
            git.ParkDecompiled(pluginFileName, binarySha256);
        }
        catch (Exception cause) when (IsAFailedWrite(cause))
        {
            var unrestored = TakeAwayAndPutBack(root, before);
            if (unrestored.Count == 0) throw;
            throw NotAllPutBack(cause, unrestored);
        }
        finally
        {
            locator.Forget();
        }
    }

    internal void RenameSource(string from, string to)
    {
        var (fromRoot, toRoot) = (SourceRepositoryLayout.RootIn(_modFolder, from), SourceRepositoryLayout.RootIn(_modFolder, to));
        var before = PreImageOf(fromRoot);
        var renamed = before.Files
            .Select(file => PluginSourceRename.Renamed(Path.GetRelativePath(_modFolder, file.Path), file.Bytes, from, to))
            .ToList();

        var putBackLastWritten = git.LastWrittenPutBack(from, to);
        try
        {
            PristineFileWriter.WriteAll(renamed, _modFolder);
            git.MoveLastWritten(from, to);
            Directory.Delete(fromRoot, recursive: true);
        }
        catch (Exception cause) when (IsAFailedWrite(cause))
        {
            var unrestored = TakeAwayAndPutBack(toRoot, before);
            TryPutBackLastWritten(putBackLastWritten, from, unrestored);
            if (unrestored.Count == 0) throw;
            throw NotAllPutBack(cause, unrestored);
        }
        finally
        {
            locator.Forget();
        }
    }

    private static bool IsAFailedWrite(Exception cause) =>
        cause is IOException or UnauthorizedAccessException or InvalidOperationException or System.ComponentModel.Win32Exception;

    private List<string> TakeAwayAndPutBack(string written, PreImage before)
    {
        var unrestored = new List<string>();
        TryPutBack(written, () => { if (Directory.Exists(written)) Directory.Delete(written, recursive: true); }, unrestored);
        unrestored.AddRange(PutBack(before));
        return unrestored;
    }

    private static IOException NotAllPutBack(Exception cause, List<string> unrestored) =>
        new($"{cause.Message} Its source is back as it was except: {string.Join(" ", unrestored)}", cause);

    private static void TryPutBackLastWritten(Action putBack, string plugin, List<string> unrestored)
    {
        try
        {
            putBack();
        }
        catch (GitCommandFailedException ex)
        {
            unrestored.Add($"what Modbench last wrote for {plugin} could not be put back: {ex.Message}");
        }
    }

    private static void DeleteEmptyDirectories(string directory)
    {
        if (!Directory.Exists(directory)) return;
        foreach (var child in Directory.GetDirectories(directory)) DeleteEmptyDirectories(child);
        if (!Directory.EnumerateFileSystemEntries(directory).Any()) Directory.Delete(directory);
    }

    // A failed recursive delete goes on past the entry it could not take, so it stops partway. The
    // pre-image puts back what went; a file still standing is left alone, as this delete never wrote it.
    private void DeleteWholeOrNotAtAll(string directory)
    {
        var before = PreImageOf(directory);
        try
        {
            Directory.Delete(directory, recursive: true);
        }
        catch (Exception cause) when (cause is IOException or UnauthorizedAccessException)
        {
            var unrestored = PutBack(before);
            if (unrestored.Count == 0) throw;
            throw new IOException(
                $"{cause.Message} Everything it removed is back except: {string.Join(" ", unrestored)}", cause);
        }
    }

    private sealed record PreImage(List<string> Directories, List<(string Path, byte[] Bytes)> Files);

    private static PreImage PreImageOf(string directory) => new(
        [.. Directory.GetDirectories(directory, "*", SearchOption.AllDirectories)
            .Prepend(directory)
            .Order(StringComparer.Ordinal)],
        [.. Directory.GetFiles(directory, "*", SearchOption.AllDirectories)
            .Order(StringComparer.Ordinal)
            .Select(path => (Path: path, Bytes: File.ReadAllBytes(path)))]);

    // One path that cannot be written never stops the pass, and every other one is still put back
    // (ADR-0019).
    private List<string> PutBack(PreImage before)
    {
        var unrestored = new List<string>();
        foreach (var level in before.Directories)
        {
            TryPutBack(level, () => Directory.CreateDirectory(level), unrestored);
        }
        foreach (var (path, bytes) in before.Files.Where(file => !File.Exists(file.Path)))
        {
            TryPutBack(path, () => File.WriteAllBytes(path, bytes), unrestored);
        }
        return unrestored;
    }

    private void TryPutBack(string path, Action write, List<string> unrestored)
    {
        try
        {
            write();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            unrestored.Add($"{Path.GetRelativePath(_modFolder, path)} could not be put back: {ex.Message}");
        }
    }

    // Move before write: a crash between leaves the record at its new name with old content, still
    // found by FormKey.
    private void MoveToItsLeafName(SourceUnit unit, SourceDocument document)
    {
        // A file whose text is not a document is something else's, and writing over it drops what it wrote.
        if (document.RecordType != PluginHeader.RecordType && !unit.IsEmbedded && File.Exists(unit.FullPath)
            && SourceRepositoryLocator.NotADocument(File.ReadAllText(unit.FullPath)) is { } why)
            throw new UnreadableSourceDocumentException($"{unit.RelativePath} is not a readable document, so its name cannot be checked: {why}");

        if (LeafMove(unit, document) is not var (from, to)) return;
        SourceRepositoryLayout.MoveEntry(from, to);
        if (unit.IsDirectoryPerRecord)
            File.Move(Path.Combine(to, Path.GetFileName(unit.FullPath)), SourceRepositoryLayout.ContainerDocumentIn(to));
        locator.Forget();
    }

    // The file or folder that holds the document, and where its layout leaf name puts it; null when it
    // is already there.
    private static (string From, string To)? LeafMove(SourceUnit unit, SourceDocument document)
    {
        if (document.RecordType == PluginHeader.RecordType || unit.IsEmbedded || !File.Exists(unit.FullPath)) return null;

        var from = unit.IsDirectoryPerRecord ? PathShape.DirectoryOf(unit.FullPath) : unit.FullPath;
        var to = Path.Combine(
            PathShape.DirectoryOf(from),
            SourceRepositoryLayout.LeafNameFor(FormKey.Factory(document.FormKey), document.EditorId, unit.IsDirectoryPerRecord));
        return string.Equals(from, to, StringComparison.Ordinal) ? null : (from, to);
    }

    private static byte[] OwnerBytes(SourceUnit unit) => DocumentText.StripUtf8Bom(File.ReadAllBytes(unit.FullPath));

    private static InvalidOperationException NoPlaceInTheTree(PluginAddress plugin, RecordIdentity identity) =>
        new($"No document in {plugin.Name}'s tree holds {identity.FormKey}, and its type has no file of " +
            "its own, so there is nowhere to write it.");

    private static InvalidOperationException NoLongerCarried(SourceUnit unit, string formKey) =>
        new($"{unit.RelativePath} was found holding {formKey}, but its own text does not carry it.");
}

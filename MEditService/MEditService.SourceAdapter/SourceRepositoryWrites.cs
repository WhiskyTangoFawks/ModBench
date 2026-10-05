using System.Text.Json;
using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>The full, absolute path a container's subtree moved from and to — what a transaction
/// needs to log the move without computing either path itself. A caller reporting one relativises it
/// to a mod folder.</summary>
internal readonly record struct MovedContainer(string From, string To);

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
        if (locator.LocateToPlace(plugin, identity) is { } held) MoveToItsEditorId(held, document);
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

    /// <summary>Moves the container <paramref name="identity"/> names to the leaf
    /// <paramref name="newFormKey"/> computes, keeping its EditorID. Null when nothing moved. Refuses
    /// before touching the tree when that leaf is already occupied.</summary>
    internal MovedContainer? Move(PluginAddress plugin, RecordIdentity identity, string newFormKey)
    {
        if (locator.Locate(plugin, identity) is not { IsEmbedded: false, IsDirectoryPerRecord: true } unit) return null;

        var from = PathShape.DirectoryOf(unit.FullPath);
        var to = Path.Combine(
            PathShape.DirectoryOf(from),
            SourceRepositoryLayout.LeafNameFor(FormKey.Factory(newFormKey), identity.EditorId, isDirectory: true));
        if (string.Equals(from, to, StringComparison.Ordinal)) return null;

        if (Directory.Exists(to) || File.Exists(to))
        {
            throw new IOException(
                $"{Path.GetFileName(to)} already exists in {Path.GetDirectoryName(to)}, so the container whose FormID changed " +
                "has nowhere to move to.");
        }

        Directory.Move(from, to);
        locator.Forget();
        return new MovedContainer(from, to);
    }

    /// <summary>The document a FormKey change writes: the record's own under its new key, or the
    /// owner's text with the embedded child under it. Throws when no readable document carries the
    /// record.</summary>
    internal SourceDocument RekeyedDocument(
        PluginAddress plugin, RecordIdentity identity, string newFormKey,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, DocumentRekey rekey)
    {
        var carrying = locator.ContainerDocument(plugin, identity, schemas)
            ?? throw new InvalidOperationException(
                $"No readable document in {plugin.Name}'s tree carries {identity.FormKey}.");

        if (carrying.FormKey.Equals(identity.FormKey, StringComparison.Ordinal))
        {
            return new SourceDocument(
                newFormKey, identity.RecordType, identity.EditorId,
                rekey.Own(carrying, newFormKey));
        }

        var ownerText = rekey.ChildOfOwner(carrying, identity.FormKey, newFormKey)
            ?? throw new InvalidOperationException(
                $"{locator.Locate(plugin, identity)?.RelativePath} was found holding {identity.FormKey}, but its own text does not carry it.");
        return carrying with { Body = ownerText };
    }

    internal void ReplaceSourceFrom(string pluginFileName, IReadOnlyList<TreeFile> files, string binarySha256)
    {
        // A mod folder another tool removed is not written back into being.
        if (!SourceRepositoryGit.IsTracked(_modFolder))
            throw new InvalidOperationException($"'{_modFolder}' holds no repository, so {pluginFileName}'s source has nowhere to go.");

        var root = SourceRepositoryLayout.RootIn(_modFolder, pluginFileName);
        var before = Directory.Exists(root) ? PreImageOf(root) : new PreImage([], []);
        try
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
            PristineFileWriter.WriteAll(files, _modFolder);
            git.ParkDecompiled(pluginFileName, binarySha256);
        }
        catch (Exception cause) when (cause is IOException or UnauthorizedAccessException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            var unrestored = new List<string>();
            TryPutBack(root, () => { if (Directory.Exists(root)) Directory.Delete(root, recursive: true); }, unrestored);
            unrestored.AddRange(PutBack(before));
            if (unrestored.Count == 0) throw;
            throw new IOException(
                $"{cause.Message} Its source is back as it was except: {string.Join(" ", unrestored)}", cause);
        }
        finally
        {
            locator.Forget();
        }
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
    // found by FormKey. A leaf something else renamed keeps its name while the EditorID is unchanged.
    private void MoveToItsEditorId(SourceUnit unit, SourceDocument document)
    {
        if (!ChangesEditorId(unit, document)) return;

        var from = unit.IsDirectoryPerRecord ? PathShape.DirectoryOf(unit.FullPath) : unit.FullPath;
        var to = Path.Combine(
            PathShape.DirectoryOf(from),
            SourceRepositoryLayout.LeafNameFor(FormKey.Factory(document.FormKey), document.EditorId, unit.IsDirectoryPerRecord));
        if (string.Equals(from, to, StringComparison.Ordinal)) return;

        if (unit.IsDirectoryPerRecord) Directory.Move(from, to);
        else File.Move(from, to, overwrite: true);
        locator.Forget();
    }

    /// <summary>Whether putting <paramref name="document"/> would rename the file it replaces. Refuses
    /// a file whose text is not a document: its EditorID cannot be compared, and overwriting it would
    /// drop what something else wrote.</summary>
    internal static bool ChangesEditorId(SourceUnit unit, SourceDocument document)
    {
        if (document.RecordType == PluginHeader.RecordType || unit.IsEmbedded || !File.Exists(unit.FullPath))
            return false;

        var text = File.ReadAllText(unit.FullPath);
        if (SourceRepositoryLocator.NotADocument(text) is { } why)
            throw new UnreadableSourceDocumentException($"{unit.RelativePath} is not a readable document, so its EditorID cannot be compared: {why}");
        return !string.Equals(EditorIdOf(text), document.EditorId, StringComparison.Ordinal);
    }

    private static string? EditorIdOf(string text)
    {
        using var document = JsonDocument.Parse(text);
        return document.RootElement.TryGetProperty(RecordMembers.EditorId, out var editorId)
            && editorId.ValueKind == JsonValueKind.String
            ? editorId.GetString()
            : null;
    }

    private static byte[] OwnerBytes(SourceUnit unit) => DocumentText.StripUtf8Bom(File.ReadAllBytes(unit.FullPath));

    private static InvalidOperationException NoPlaceInTheTree(PluginAddress plugin, RecordIdentity identity) =>
        new($"No document in {plugin.Name}'s tree holds {identity.FormKey}, and its type has no file of " +
            "its own, so there is nowhere to write it.");

    private static InvalidOperationException NoLongerCarried(SourceUnit unit, string formKey) =>
        new($"{unit.RelativePath} was found holding {formKey}, but its own text does not carry it.");
}

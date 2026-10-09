using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>A flat record's identity as recovered from its own path. No FormKey: an EditorID can
/// legally contain <c>" - "</c>, so splitting the file name is ambiguous.</summary>
internal sealed record SourceRecordIdentity(string PluginFileName, string RecordType);

/// <summary>Where a record with a file of its own lands, relative to the mod folder.
/// <see cref="SourceRepositoryLayout.PlacementFor"/> is the only thing that computes one.</summary>
internal readonly record struct SourcePlacement(string RelativePath);

/// <summary>The source tree's layout: the only type spelling the root folder, the door's file names
/// and the JSON suffix. The instance places a new document and mints the levels above it.</summary>
internal sealed class SourceRepositoryLayout(string modFolder, GameRelease release, SourceRepositoryLocator locator)
{
    private readonly string _modFolder = modFolder;
    private readonly GameRelease _release = release;

    /// <summary>Plain, not dot-prefixed: the plugin's source is first-class, not hidden metadata. The
    /// deployer exclusion matches this name at the mod root only, so a nested folder that merely
    /// shares it still deploys.</summary>
    internal const string RootFolderName = "plugin-source";

    /// <summary>The whole-mod door's own name for a group or block level's metadata file, written for
    /// every minted level, empty unless the level has non-default metadata.</summary>
    internal const string GroupRecordDataFileName = "GroupRecordData.json";

    /// <summary>The suffix the layout reads as "this file may hold a record".</summary>
    internal const string JsonSuffix = ".json";

    /// <summary><c>plugin-source/&lt;pluginFileName&gt;</c>, one root rather than a per-plugin sibling
    /// tree: a per-plugin suffix guard orphans the tree when its plugin is renamed outside Modbench.</summary>
    internal static string RootFor(string pluginFileName) => Path.Combine(RootFolderName, pluginFileName);

    /// <summary>The mod's own display name, for a caller naming it in a message without reaching
    /// for the path itself.</summary>
    internal static string ModNameIn(string modFolder) =>
        Path.GetFileName(modFolder.TrimEnd(Path.DirectorySeparatorChar));

    internal static string RootIn(string modFolder, string pluginFileName) =>
        Path.Combine(modFolder, RootFor(pluginFileName));

    /// <summary>The folder of the mod's plugin source holding <paramref name="pluginFileName"/>'s tree: the one spelled
    /// so, else the only one spelled so without case, as a ModKey compares a name. Null for none, or for twins.</summary>
    internal static string? TreeNameIn(string modFolder, string pluginFileName)
    {
        List<string> named;
        try
        {
            named = [.. Directory.EnumerateDirectories(Path.Combine(modFolder, RootFolderName))
                .Select(Path.GetFileName)
                .OfType<string>()
                .Where(name => name.Equals(pluginFileName, StringComparison.OrdinalIgnoreCase))];
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }

        if (named.Contains(pluginFileName, StringComparer.Ordinal)) return pluginFileName;
        return named is [var only] ? only : null;
    }

    /// <summary>The folder of the mod's plugin source that <paramref name="fullPath"/> sits in, as the path spells
    /// it; null for a path outside the plugin source.</summary>
    internal static string? TreeFolderHolding(string modFolder, string fullPath)
    {
        var sources = Path.GetFullPath(Path.Combine(modFolder, RootFolderName));
        return SourceRepositoryLocator.IsUnder(sources, fullPath)
            ? Path.GetRelativePath(sources, fullPath).Split(Path.DirectorySeparatorChar)[0]
            : null;
    }

    /// <summary>One plugin's serialized tree as the files a mod folder holds — what Track and
    /// decompile write.</summary>
    internal static IReadOnlyList<TreeFile> PristineFilesOf(
        string pluginFileName, IEnumerable<TreeFile> treeFiles) =>
        [.. treeFiles.Select(file => PlacedFileOf(pluginFileName, file))];

    /// <summary>One file of the door's tree where the mod folder holds it.</summary>
    internal static TreeFile PlacedFileOf(string pluginFileName, TreeFile doorFile) =>
        new(doorFile.RelativePath == DocumentFileNames.Root
                ? HeaderDocumentFor(pluginFileName)
                : Path.Combine(RootFor(pluginFileName), SourceNameOf(doorFile.RelativePath)),
            doorFile.Content);

    /// <summary>Placed files of <paramref name="pluginFileName"/>'s tree as the whole-mod door names them,
    /// relative to the tree's root.</summary>
    internal static IReadOnlyList<TreeFile> DoorTreeOf(
        string pluginFileName, IEnumerable<TreeFile> files, GameRelease gameRelease)
    {
        var held = files.ToList();
        return [.. DoorNames(pluginFileName, held, gameRelease).Zip(held, (name, file) => new TreeFile(name.Door, file.Content))];
    }

    /// <summary><paramref name="diagnosis"/> of a read of <paramref name="files"/>' door tree, each file it
    /// names named where <paramref name="files"/> hold it. A name inside another path is that path's.</summary>
    internal static PluginDiagnosis InSourceNames(
        string pluginFileName, PluginDiagnosis diagnosis, IEnumerable<TreeFile> files, GameRelease gameRelease)
    {
        var names = DoorNames(pluginFileName, [.. files], gameRelease).ToList();
        string SourceOf(string door) =>
            names.FirstOrDefault(name => name.Door == door).Source ?? Path.Combine(RootFor(pluginFileName), door);

        return diagnosis with
        {
            Anchor = diagnosis.Anchor is { } anchor ? SourceOf(anchor) : null,
            Message = names.Aggregate(diagnosis.Message, (text, name) =>
                Regex.Replace(text, $@"(?<![\w/\\.-]){Regex.Escape(name.Door)}(?!\.?[\w/\\-])", _ => name.Source)),
        };
    }

    private static IEnumerable<(string Source, string Door)> DoorNames(
        string pluginFileName, IReadOnlyList<TreeFile> files, GameRelease gameRelease)
    {
        var root = RootFor(pluginFileName);
        var sources = files.Select(file => file.RelativePath).ToList();
        var documents = ContainerDocumentsAmong(sources, gameRelease);
        string DoorName(string source)
        {
            if (IsHeaderDocumentPath(source, pluginFileName)) return DocumentFileNames.Root;
            return Path.GetRelativePath(root, documents.Contains(source)
                ? Path.Combine(PathShape.DirectoryOf(source), DocumentFileNames.Root)
                : source);
        }

        return sources.Select(source => (source, DoorName(source)));
    }

    private static string SourceNameOf(string doorPath) =>
        Path.GetFileName(doorPath).Equals(DocumentFileNames.Root, StringComparison.Ordinal)
            ? ContainerDocumentIn(PathShape.DirectoryOf(doorPath))
            : doorPath;

    /// <summary>The file a container's directory is written with: the one its leaf names.</summary>
    internal static string ContainerDocumentIn(string directory) =>
        Path.Combine(directory, Path.GetFileName(directory) + JsonSuffix);

    /// <summary>Whether <paramref name="relativePath"/> sits where a container's document does: in a record
    /// directory of a directory-per-record group.</summary>
    internal static bool InAContainerGroup(string relativePath, GameRelease gameRelease)
    {
        var path = new LayoutPath(relativePath);
        return path.IsContainerDocument
            && GroupFolders.For(gameRelease).DirectoryPerRecordFolders.Contains(path.GroupFolderName);
    }

    /// <summary>Each container directory's document among <paramref name="relativePaths"/>, by the one rule of
    /// <see cref="ContainerDocumentAmong"/>.</summary>
    internal static HashSet<string> ContainerDocumentsAmong(IEnumerable<string> relativePaths, GameRelease gameRelease) =>
        relativePaths
            .Where(path => InAContainerGroup(path, gameRelease))
            .GroupBy(path => PathShape.DirectoryOf(path), StringComparer.Ordinal)
            .Select(directory => ContainerDocumentAmong(directory.Key, directory))
            .ToHashSet(StringComparer.Ordinal);

    /// <summary>The document a container's directory holds: the one its leaf names, else the only one. Several,
    /// none so named, throw: no one record's document can be told.</summary>
    internal static string ContainerDocumentAmong(string directory, IEnumerable<string> documents)
    {
        var named = ContainerDocumentIn(directory);
        var held = documents.ToList();
        if (held.Contains(named, StringComparer.Ordinal)) return named;

        return held.Count switch
        {
            0 => named,
            1 => held[0],
            _ => throw SourceStopException.Ambiguous(
                $"{directory} holds more than one document ({string.Join(", ", held.Select(Path.GetFileName))}) and none is named " +
                "for the directory, so no one record's document can be told. Remove the extra ones by hand."),
        };
    }

    internal static string ContainerDocumentHeldBy(string directory) =>
        ContainerDocumentAmong(
            directory,
            Directory.Exists(directory) ? Directory.EnumerateFiles(directory).Where(file => !CarriesNoRecord(file)) : []);

    /// <summary>The plugin header's own document, named for its FormKey: a header has no EditorID.</summary>
    internal static string HeaderDocumentIn(string modFolder, string pluginFileName) =>
        Path.Combine(modFolder, HeaderDocumentFor(pluginFileName));

    /// <summary>The plugin header's own document, relative to the mod folder.</summary>
    internal static string HeaderDocumentFor(string pluginFileName) =>
        Path.Combine(RootFor(pluginFileName), HeaderDocumentLeaf(pluginFileName));

    internal static string HeaderDocumentLeaf(string pluginFileName) =>
        FileNameFor(FormKey.Factory(HeaderFormKeyOf(pluginFileName)), editorId: null);

    // The flat record's own file. The origin ModKey, never the plugin written into, keeps two
    // masters' records from colliding on one path; a directory-per-record type refuses.
    internal static string FlatPathFor(
        string pluginFileName, string recordType, string formKeyString, string? editorId, GameRelease gameRelease)
    {
        var folder = GroupFolders.For(gameRelease).FlatFolderOf(recordType)
            ?? throw new NotSupportedException(
                $"'{recordType}' has no flat source path under the source layout — it is a " +
                "directory-per-record container type (Cell/Worldspace), or has no top-level " +
                "group at all, and the repository's own locator owns it, not this helper.");

        return Path.Combine(
            RootFor(pluginFileName), folder,
            FileNameFor(FormKey.Factory(formKeyString), editorId));
    }

    // The three shapes with a group folder: flat file, container directory, and an interior Cell
    // nested under block/sub-block, the only reason blockPath exists. An embedded child lands
    // inside its container's document instead.
    internal static SourcePlacement PlacementFor(
        string pluginFileName,
        string recordType,
        string formKeyString,
        string? editorId,
        GameRelease gameRelease,
        IReadOnlyList<string>? blockPath = null)
    {
        var folders = GroupFolders.For(gameRelease);

        // A flat record has a top-level group folder of its own and needs no directory.
        if (folders.FlatFolderOf(recordType) is not null)
            return new SourcePlacement(FlatPathFor(pluginFileName, recordType, formKeyString, editorId, gameRelease));

        var groupFolder = folders.FolderOf(recordType)
            ?? throw new NotSupportedException(
                $"'{recordType}' has no group folder at all — it is an embedded child, which lands inside " +
                "its container's document rather than at a path of its own.");

        var leaf = LeafNameFor(FormKey.Factory(formKeyString), editorId, isDirectory: true);

        return new SourcePlacement(ContainerDocumentIn(Path.Combine(
            [RootFor(pluginFileName), groupFolder, .. blockPath ?? [], leaf])));
    }

    // "<x>, <y>", the whole-mod door's own name for a block level's directory, and the spelling
    // Coordinates reads the numbers back out of. A missing number is the zero the door writes.
    internal static string BlockLevelName(int? x, int? y) =>
        string.Create(CultureInfo.InvariantCulture, $"{x ?? 0}, {y ?? 0}");

    // "[<EditorID> - ]<hex6>_<originModKey>", ".json" on a flat file only. The EditorID is cut so a
    // deep path stays under Windows' 260 characters; the FormKey part keeps the name unique.
    private const int MaxEditorIdInLeaf = 64;

    internal static string LeafNameFor(FormKey formKey, string? editorId, bool isDirectory)
    {
        var extension = isDirectory ? string.Empty : JsonSuffix;
        var filesafe = FilesafeFormKey(formKey);

        if (string.IsNullOrEmpty(editorId)) return $"{filesafe}{extension}";

        var named = editorId.Length > MaxEditorIdInLeaf ? editorId[..MaxEditorIdInLeaf] : editorId;
        return $"{named} - {filesafe}{extension}";
    }

    internal static string FileNameFor(FormKey formKey, string? editorId) => LeafNameFor(formKey, editorId, isDirectory: false);

    internal static string FilesafeFormKey(string formKey) => FilesafeFormKey(FormKey.Factory(formKey));

    internal static string FilesafeFormKey(FormKey formKey) => $"{formKey.ID:X6}_{formKey.ModKey.FileName}";

    private const int FormIdDigits = 6;

    /// <summary><paramref name="leaf"/> under <paramref name="to"/> when it names a record that
    /// originates in <paramref name="from"/>; any other leaf as it is.</summary>
    internal static string LeafWithOrigin(string leaf, ModKey from, ModKey to)
    {
        var extension = leaf.EndsWith(JsonSuffix, StringComparison.OrdinalIgnoreCase) ? leaf[^JsonSuffix.Length..] : "";
        var name = leaf[..^extension.Length];
        var filesafeLength = FormIdDigits + 1 + from.FileName.String.Length;
        if (name.Length < filesafeLength) return leaf;

        var filesafe = name[^filesafeLength..];
        if (!FormKey.TryFactory($"{filesafe[..FormIdDigits]}:{filesafe[(FormIdDigits + 1)..]}", out var formKey)
            || formKey.ModKey != from
            || !NameCarries(name, filesafe))
        {
            return leaf;
        }
        return $"{name[..^filesafeLength]}{FilesafeFormKey(new FormKey(to, formKey.ID))}{extension}";
    }

    /// <summary>The record type of the document at <paramref name="relativePath"/>. Null means the
    /// path does not decide it, so the document names its own type.</summary>
    internal static string? RecordTypeOf(string relativePath, GameRelease gameRelease)
    {
        if (ParseDocumentPath(relativePath, gameRelease) is { } identity) return identity.RecordType;

        var path = new LayoutPath(relativePath);
        return path.IsContainerDocument
            ? GroupFolders.For(gameRelease)
                .DirectoryPerRecordTypeIn(path.GroupFolderName, nested: path.ContainerIsNested)
            : null;
    }

    /// <summary>Null on anything not shaped like a flat record's path or the header's root document,
    /// so a tree walk never misreads a container path as a flat record.</summary>
    internal static SourceRecordIdentity? ParseDocumentPath(string relativePath, GameRelease gameRelease)
    {
        var path = new LayoutPath(relativePath);

        if (path.IsHeaderDocument)
            return new SourceRecordIdentity(path.PluginFileName, PluginHeader.RecordType);

        if (!path.IsFlatDocument) return null;
        if (GroupFolders.For(gameRelease).RecordTypeIn(path.GroupFolderName) is not { } recordType)
            return null;

        return new SourceRecordIdentity(path.PluginFileName, recordType);
    }

    /// <summary>True for a file under the source root that holds no record — group and block metadata,
    /// and anything that is not a document at all. No row is derived from one.</summary>
    internal static bool CarriesNoRecord(string filePath) =>
        !filePath.EndsWith(JsonSuffix, StringComparison.OrdinalIgnoreCase)
        || Path.GetFileName(filePath).Equals(GroupRecordDataFileName, StringComparison.Ordinal);

    /// <summary>Whether <paramref name="path"/> names the header's own document. A suffix, not an
    /// equality: the caller may spell it absolute, relative to the mod folder, or as git does.</summary>
    internal static bool IsHeaderDocumentPath(string path, string pluginFileName) =>
        IsHeaderDocumentPath(Segments(path), pluginFileName);

    private static bool IsHeaderDocumentPath(string[] segments, string pluginFileName) =>
        EndsWith(segments, Segments(HeaderDocumentFor(pluginFileName)));

    internal static string HeaderFormKeyOf(string pluginFileName) =>
        PluginHeader.FormKeyFor(ModKey.FromFileName(pluginFileName));

    private static string[] Segments(string path) =>
        path.Split(['/', '\\'], StringSplitOptions.RemoveEmptyEntries);

    private static bool EndsWith(string[] segments, string[] tail) =>
        segments.Length >= tail.Length
        && segments.AsSpan(segments.Length - tail.Length).SequenceEqual(tail);

    // The whole-mod door's two name shapes: the filesafe FormKey alone, or "<EditorID> - " ahead of it.
    // Anchored at both ends so a name that merely embeds the text cannot match.
    internal static bool NameCarries(string leaf, string tail) =>
        leaf.Equals(tail, StringComparison.Ordinal)
        || (leaf.EndsWith(tail, StringComparison.Ordinal)
            && leaf.EndsWith($" - {tail}", StringComparison.Ordinal));

    /// <summary>Where a new document lands, and the block level documents the tree lacks above it, outermost
    /// first. Null for a record with no group folder, which lands inside its container's document.</summary>
    internal (IReadOnlyList<DocumentChange> Levels, SourceUnit Unit)? PlaceNewDocument(
        PluginAddress plugin, RecordIdentity identity, CellPlacement? placement)
    {
        var types = RecordTypes.For(_release);
        if (GroupFolders.For(_release).FolderOf(identity.RecordType) is not { } groupFolder) return null;

        // The one document that does not sit in a group folder at all. Only the placement it is put
        // with tells an exterior cell from an interior one, which has no worldspace above it.
        if (types.IsCell(identity.RecordType) && placement is { IsInterior: false } exterior)
        {
            var (exteriorLevels, cell) = ExteriorCellDocuments(plugin, identity, exterior);
            return (exteriorLevels, locator.Unit(cell, identity.FormKey, identity.RecordType, isEmbedded: false));
        }

        var (levels, blockPath) = types.IsCell(identity.RecordType)
            ? InteriorCellBlocksIn(
                Path.Combine(_modFolder, RootFor(plugin.Name), groupFolder), FormKey.Factory(identity.FormKey).ID)
            : ([], null);

        var where = PlacementFor(
            plugin.Name, identity.RecordType, identity.FormKey, identity.EditorId, _release, blockPath);
        return (levels, locator.Unit(
            Path.Combine(_modFolder, where.RelativePath), identity.FormKey, identity.RecordType, isEmbedded: false));
    }

    // The block level documents an exterior cell at the placement needs and the tree lacks, outermost
    // first, and the path of the cell's own document.
    private (IReadOnlyList<DocumentChange> Levels, string Cell) ExteriorCellDocuments(
        PluginAddress plugin, RecordIdentity identity, CellPlacement placement)
    {
        var levels = RecordTypes.For(_release).ExteriorCellBlockLevels;
        if (levels.Count != ExteriorBlockLevels)
        {
            throw new NotSupportedException(
                $"{_release} nests an exterior cell under {levels.Count} block levels, and the source " +
                $"tree's layout has exactly {ExteriorBlockLevels}.");
        }

        var (block, subBlock, cell) = ExteriorCellLevels(plugin, identity, placement);
        (string Directory, string Level, int? X, int? Y)[] needed =
        [
            (block, levels[0], placement.BlockX, placement.BlockY),
            (subBlock, levels[1], placement.SubX, placement.SubY),
        ];
        return (
            [.. needed
                .Select(level => (Path: Path.Combine(level.Directory, GroupRecordDataFileName), level.Level, level.X, level.Y))
                .Where(level => !File.Exists(level.Path))
                .Select(level => LevelDocument(level.Path, BlockLevelDocument(level.Level, level.X, level.Y)))],
            ContainerDocumentIn(cell));
    }

    // The directories an exterior cell's put lands in, none of them minted.
    internal (string Block, string SubBlock, string Cell) ExteriorCellLevels(
        PluginAddress plugin, RecordIdentity identity, CellPlacement placement)
    {
        var block = Path.Combine(WorldspaceDirectoryHolding(plugin, placement), BlockLevelName(placement.BlockX, placement.BlockY));
        var subBlock = Path.Combine(block, BlockLevelName(placement.SubX, placement.SubY));
        return (block, subBlock, Path.Combine(subBlock, LeafNameFor(FormKey.Factory(identity.FormKey), identity.EditorId, isDirectory: true)));
    }

    private const int ExteriorBlockLevels = 2;

    // Found by the worldspace's FormKey, not composed from it, so an override the destination named itself
    // is written into, never doubled by a bare-named sibling. Only the codec mints a worldspace, so the
    // tree must hold it.
    private string WorldspaceDirectoryHolding(PluginAddress plugin, CellPlacement placement)
    {
        if (placement.ParentWorldspace is not { } worldspace)
            throw new InvalidOperationException("An exterior cell's placement names no worldspace to place it under.");

        if (locator.FindOwnUnit(Path.Combine(_modFolder, RootFor(plugin.Name)), plugin, worldspace) is not { } document)
        {
            throw new InvalidOperationException(
                $"{plugin.Name}'s tree holds no document for worldspace {worldspace}, so an exterior cell " +
                "inside it has nowhere to land.");
        }
        return PathShape.DirectoryOf(document);
    }

    // Only a level the tree lacks gets one: Track writes a level's document with whatever metadata the
    // source mod carried, and a cell landing in the level is no reason to respell it.
    private string BlockLevelDocument(string level, int? x, int? y) =>
        RecordTextCodec.BlankDocument(
            level, _release,
            new JsonObject
            {
                [RecordTypes.BlockNumberXMember] = x ?? 0,
                [RecordTypes.BlockNumberYMember] = y ?? 0,
            });

    private DocumentChange LevelDocument(string fullPath, string text) => new(Path.GetRelativePath(_modFolder, fullPath), text);

    // Block = ID mod 10 and sub-block = ID / 10 mod 10: the formula of Mutagen's AddInteriorCell.
    private (IReadOnlyList<DocumentChange> Levels, List<string> BlockPath) InteriorCellBlocksIn(
        string groupDirectory, uint formId)
    {
        var levels = RecordTypes.For(_release).InteriorCellBlockLevels;
        var labels = RecordTypes.InteriorCellBlockGroupTypes;
        if (levels.Count != labels.Count)
        {
            throw new NotSupportedException(
                $"{_release} nests an interior cell under {levels.Count} block levels, and the source " +
                $"tree's layout has exactly {labels.Count}.");
        }

        // The group's own level has no blank document to ask the codec for: its class has a generated
        // serializer and no deserializer. The compile round-trip gate needs the file, so the empty
        // document stands in.
        var documents = new List<DocumentChange>();
        var groupDocument = Path.Combine(groupDirectory, GroupRecordDataFileName);
        if (!File.Exists(groupDocument)) documents.Add(LevelDocument(groupDocument, EmptyLevelDocument));

        int[] numbers = [(int)(formId % 10), (int)(formId / 10 % 10)];
        var path = new List<string>();
        var parent = groupDirectory;
        for (var level = 0; level < levels.Count; level++)
        {
            parent = Path.Combine(parent, numbers[level].ToString(CultureInfo.InvariantCulture));
            path.Add(Path.GetFileName(parent));
            if (Directory.Exists(parent)) continue;

            documents.Add(LevelDocument(Path.Combine(parent, GroupRecordDataFileName), RecordTextCodec.BlankDocument(
                levels[level], _release,
                new JsonObject
                {
                    [RecordTypes.GroupTypeMember] = labels[level],
                    [RecordTypes.BlockNumberMember] = numbers[level],
                })));
        }
        return (documents, path);
    }

    private static readonly string EmptyLevelDocument = new JsonObject().ToJsonString();
}

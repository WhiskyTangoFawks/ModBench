using System.Globalization;
using System.Text.Json.Nodes;
using MEditService.Core.Plugins;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Source;

/// <summary>A flat record's identity as recovered from its own path. No FormKey: an EditorID can
/// legally contain <c>" - "</c>, so splitting the file name is ambiguous.</summary>
internal sealed record SourceRecordIdentity(string PluginFileName, string RecordType);

/// <summary>Where a record with a file of its own lands, relative to the mod folder.
/// <see cref="SourceRepository.PlacementFor"/> is the only thing that computes one.</summary>
internal readonly record struct SourcePlacement(string RelativePath);

/// <summary>A mod folder's git watch targets, as <see cref="SourceRepository.GitWatchPathsIn"/>
/// answers them — the paths a watcher compares against, never spells itself.</summary>
public sealed record GitWatchPaths(string GitDirectory, string Head, string PackedRefs, string RefsDirectory);

/// <summary>The source tree's layout: the only type spelling the root folder, the door's file names
/// and the JSON suffix. Everything else asks for a path rather than composing one.</summary>
public sealed partial class SourceRepository
{
    /// <summary>Plain, not dot-prefixed: the plugin's source is first-class, not hidden metadata. The
    /// deployer exclusion matches this name at the mod folder root only, so a nested
    /// <c>Scripts/Source/</c> always deploys.</summary>
    internal const string RootFolderName = "source";

    /// <summary>The whole-mod door's own name for a container's field file, and for the header's
    /// document at the plugin tree's root.</summary>
    internal const string RecordDataFileName = "RecordData.json";

    /// <summary>The whole-mod door's own name for a group or block level's metadata file, written for
    /// every minted level, empty unless the level has non-default metadata.</summary>
    internal const string GroupRecordDataFileName = "GroupRecordData.json";

    /// <summary>The suffix the layout reads as "this file may hold a record".</summary>
    internal const string JsonSuffix = ".json";

    /// <summary><c>source/&lt;pluginFileName&gt;</c>, one root rather than a per-plugin sibling tree: a
    /// per-plugin suffix guard orphans the tree when its plugin is renamed outside Modbench.</summary>
    internal static string RootFor(string pluginFileName) => Path.Combine(RootFolderName, pluginFileName);

    /// <summary>The folder holding <paramref name="pluginFileName"/>'s documents. It need not exist:
    /// an untracked mod has none until Track writes one.</summary>
    public static string RootIn(string modFolder, string pluginFileName) =>
        Path.Combine(modFolder, RootFor(pluginFileName));

    /// <summary>The mod folder's git internals for the watcher (ADR-0014): the directory, and the ref
    /// paths whose change means a commit, checkout or reset.</summary>
    public static GitWatchPaths GitWatchPathsIn(string modFolder)
    {
        var gitDirectory = Path.Combine(modFolder, ".git");
        return new GitWatchPaths(
            gitDirectory,
            Path.Combine(gitDirectory, "HEAD"),
            Path.Combine(gitDirectory, "packed-refs"),
            Path.Combine(gitDirectory, "refs"));
    }

    /// <summary>The plugin header's own document: the whole-mod door's root RecordData.json.</summary>
    internal static string HeaderDocumentIn(string modFolder, string pluginFileName) =>
        Path.Combine(RootIn(modFolder, pluginFileName), RecordDataFileName);

    /// <summary>The flat record's own file. The origin ModKey, never the plugin written into, keeps
    /// two masters' records from colliding on one path; a directory-per-record type refuses.</summary>
    internal static string FlatPathFor(
        string pluginFileName, string recordType, string formKeyString, string? editorId, GameRelease gameRelease)
    {
        var folder = RecordTypeDispatch.For(gameRelease).FolderNameFor(recordType)
            ?? throw new NotSupportedException(
                $"'{recordType}' has no flat source path under the source layout — it is a " +
                "directory-per-record container type (Cell/Worldspace), or has no top-level " +
                "group at all, and the repository's own locator owns it, not this helper.");

        return Path.Combine(
            RootFor(pluginFileName), folder,
            LeafNameFor(FormKey.Factory(formKeyString), editorId, isDirectory: false));
    }

    /// <summary>The three shapes with a group folder: flat file, container directory, and an interior
    /// Cell nested under block/sub-block, the only reason <paramref name="blockPath"/> exists. An
    /// embedded child lands inside its container's document instead.</summary>
    internal static SourcePlacement PlacementFor(
        string pluginFileName,
        string recordType,
        string formKeyString,
        string? editorId,
        GameRelease gameRelease,
        IReadOnlyList<string>? blockPath = null)
    {
        var dispatch = RecordTypeDispatch.For(gameRelease);

        // A flat record has a top-level group folder of its own and needs no directory.
        if (dispatch.FolderNameFor(recordType) is not null)
            return new SourcePlacement(FlatPathFor(pluginFileName, recordType, formKeyString, editorId, gameRelease));

        var groupFolder = dispatch.GroupFolderNameFor(recordType)
            ?? throw new NotSupportedException(
                $"'{recordType}' has no group folder at all — it is an embedded child, which lands inside " +
                "its container's document rather than at a path of its own.");

        var leaf = LeafNameFor(FormKey.Factory(formKeyString), editorId, isDirectory: true);

        return new SourcePlacement(Path.Combine(
            [RootFor(pluginFileName), groupFolder, .. blockPath ?? [], leaf, RecordDataFileName]));
    }

    // "<x>, <y>", the whole-mod door's own name for a block level's directory, and the spelling
    // Coordinates reads the numbers back out of. A missing number is the zero the door writes.
    private static string BlockLevelName(int? x, int? y) =>
        string.Create(CultureInfo.InvariantCulture, $"{x ?? 0}, {y ?? 0}");

    /// <summary><c>[&lt;EditorID&gt; - ]&lt;hex6&gt;_&lt;originModKey&gt;</c>, with <c>.json</c> for a flat
    /// file and without for a container's directory — the reason an EditorID edit is a rename.</summary>
    internal static string LeafNameFor(FormKey formKey, string? editorId, bool isDirectory)
    {
        var extension = isDirectory ? string.Empty : JsonSuffix;
        var filesafe = FilesafeFormKey(formKey);

        return string.IsNullOrEmpty(editorId) ? $"{filesafe}{extension}" : $"{editorId} - {filesafe}{extension}";
    }

    internal static string FilesafeFormKey(string formKey) => FilesafeFormKey(FormKey.Factory(formKey));

    private static string FilesafeFormKey(FormKey formKey) => $"{formKey.ID:X6}_{formKey.ModKey.FileName}";

    /// <summary>The record type of the document at <paramref name="relativePath"/>. Null means the
    /// path does not decide it, so the document names its own type.</summary>
    internal static string? RecordTypeOf(string relativePath, GameRelease gameRelease)
    {
        if (TryParseDocumentPath(relativePath, gameRelease, out var identity)) return identity.RecordType;

        var path = new LayoutPath(relativePath);
        return path.IsContainerDocument
            ? RecordTypeDispatch.For(gameRelease)
                .DirectoryPerRecordTypeIn(path.GroupFolderName, nested: path.ContainerIsNested)
            : null;
    }

    /// <summary>Fails closed on anything not shaped like a flat record's path or the header's root
    /// document, so a tree walk never misreads a container path as a flat record.</summary>
    internal static bool TryParseDocumentPath(
        string relativePath, GameRelease gameRelease, out SourceRecordIdentity identity)
    {
        identity = null!;
        var path = new LayoutPath(relativePath);

        if (path.IsHeaderDocument)
        {
            identity = new SourceRecordIdentity(path.PluginFileName, PluginHeader.RecordType);
            return true;
        }

        if (!path.IsFlatDocument) return false;
        if (RecordTypeDispatch.For(gameRelease).RecordTypeForFolder(path.GroupFolderName) is not { } recordType)
            return false;

        identity = new SourceRecordIdentity(path.PluginFileName, recordType);
        return true;
    }

    /// <summary>True for a file under the source root that holds no record — group and block metadata,
    /// and anything that is not a document at all. No row is derived from one.</summary>
    public static bool CarriesNoRecord(string filePath) =>
        !filePath.EndsWith(JsonSuffix, StringComparison.OrdinalIgnoreCase)
        || Path.GetFileName(filePath).Equals(GroupRecordDataFileName, StringComparison.Ordinal);

    /// <summary>Whether <paramref name="leaf"/> names the record with <paramref name="formKey"/> — asked
    /// in the one unambiguous direction, since an EditorID containing <c>" - "</c> makes splitting a
    /// name undecidable.</summary>
    internal static bool NameCarriesFormKey(string leaf, string formKey)
    {
        var filesafe = FilesafeFormKey(formKey);
        return NameCarries(leaf, filesafe) || NameCarries(leaf, filesafe + JsonSuffix);
    }

    // The whole-mod door's two name shapes: the filesafe FormKey alone, or "<EditorID> - " ahead of it.
    // Anchored at both ends so a name that merely embeds the text cannot match.
    internal static bool NameCarries(string leaf, string tail) =>
        leaf.Equals(tail, StringComparison.Ordinal)
        || (leaf.EndsWith(tail, StringComparison.Ordinal)
            && leaf.EndsWith($" - {tail}", StringComparison.Ordinal));

    // The computed path when it exists, else whichever file in the group folder carries this FormKey:
    // name and document EditorIDs can disagree, and the name alone reads a live record as deleted.
    private static string FlatSourcePath(
        string modFolder, string pluginFileName, string recordType, string formKey, string? editorId,
        GameRelease release)
    {
        var computed = Path.Combine(
            modFolder, FlatPathFor(pluginFileName, recordType, formKey, editorId, release));
        if (File.Exists(computed)) return computed;

        var groupFolder = RecordTypeDispatch.For(release).FolderNameFor(recordType);
        if (groupFolder == null) return computed;

        var groupDirectory = Path.Combine(RootIn(modFolder, pluginFileName), groupFolder);
        if (!Directory.Exists(groupDirectory)) return computed;

        var suffix = FilesafeFormKey(formKey) + JsonSuffix;
        var matches = Directory
            .EnumerateFiles(groupDirectory, $"*{suffix}", SearchOption.TopDirectoryOnly)
            .Where(f => NameCarries(Path.GetFileName(f), suffix))
            .Take(2)
            .ToList();

        return matches.Count switch
        {
            0 => computed,
            1 => matches[0],
            _ => throw new AmbiguousSourceUnitException(
                $"More than one file in '{groupDirectory}' claims FormKey {formKey}. A FormKey is unique " +
                "within a mod, so this tree is corrupt — most likely a rename that was interrupted " +
                "partway. Resolve the duplicate by hand before editing."),
        };
    }

    /// <summary>One place that knows a container is a directory and a flat record a file, so callers and
    /// the rollback cannot disagree.</summary>
    internal static void MoveEntry(string from, string to)
    {
        if (Directory.Exists(from)) Directory.Move(from, to);
        else File.Move(from, to);
    }

    /// <summary>The codec's own write-then-rename, for the writers that hold text rather than a
    /// record: an interrupted direct write leaves a partial file that dirty detection reads as an
    /// edit.</summary>
    internal static void WriteTextAtomic(string filePath, string body)
    {
        var tempPath = filePath + ".tmp";
        try
        {
            File.WriteAllText(tempPath, body);
            File.Move(tempPath, filePath, overwrite: true);
        }
        catch
        {
            File.Delete(tempPath);
            throw;
        }
    }

    /// <summary>The levels of <paramref name="directory"/> that do not exist yet, deepest first — what
    /// creating it mints, and so what undoing it has to take away again.</summary>
    internal static IReadOnlyList<string> LevelsMintedBy(string directory)
    {
        var minted = new List<string>();
        for (var level = directory;
             !string.IsNullOrEmpty(level) && !Directory.Exists(level);
             level = Path.GetDirectoryName(level))
        {
            minted.Add(level);
        }
        return minted;
    }

    /// <summary>Removes the directories this call minted when <paramref name="write"/> throws: an
    /// empty record directory is invisible to git and fails the next ingest, since the reader opens
    /// every one unconditionally.</summary>
    internal static T InMintedDirectory<T>(string directory, Func<T> write)
    {
        var minted = LevelsMintedBy(directory);

        try
        {
            Directory.CreateDirectory(directory);
            return write();
        }
        catch
        {
            RemoveMintedLevels(minted);
            throw;
        }
    }

    internal static void InMintedDirectory(string directory, Action write) =>
        InMintedDirectory(directory, () => { write(); return true; });

    // Where a document this plugin does not hold yet lands, from the identity alone. Null for a
    // record with no group folder: it lands inside its container's document, which its own identity
    // cannot name.
    private SourceUnit? PlaceNewDocument(PluginKey plugin, RecordIdentity identity, CellPlacement? placement)
    {
        var dispatch = RecordTypeDispatch.For(_release);
        if (dispatch.GroupFolderNameFor(identity.RecordType) is not { } groupFolder) return null;

        // The one document that does not sit in a group folder at all. Only the placement it is put
        // with tells an exterior cell from an interior one, which has no worldspace above it.
        if (dispatch.IsCell(identity.RecordType) && placement is { IsInterior: false } exterior)
        {
            return Unit(
                Path.Combine(ExteriorCellDirectory(plugin, identity, exterior), RecordDataFileName),
                identity.FormKey, identity.RecordType, isEmbedded: false);
        }

        // A Cell's block bucket is the one level chosen rather than derived, so it is settled — and
        // minted — before the placement it becomes part of.
        var blockPath = dispatch.IsCell(identity.RecordType)
            ? InteriorCellBlockPathIn(Path.Combine(_modFolder, RootFor(plugin.Name), groupFolder))
            : null;

        var where = PlacementFor(
            plugin.Name, identity.RecordType, identity.FormKey, identity.EditorId, _release, blockPath);
        return Unit(
            Path.Combine(_modFolder, where.RelativePath), identity.FormKey, identity.RecordType, isEmbedded: false);
    }

    // The worldspace's directory is found by its FormKey rather than composed from it: an override
    // the destination named itself is written into, never doubled by a bare-named sibling.
    private string ExteriorCellDirectory(PluginKey plugin, RecordIdentity identity, CellPlacement placement)
    {
        var levels = RecordTypeDispatch.For(_release).ExteriorCellBlockLevels;
        if (levels.Count != ExteriorBlockLevels)
        {
            throw new NotSupportedException(
                $"{_release} nests an exterior cell under {levels.Count} block levels, and the source " +
                $"tree's layout has exactly {ExteriorBlockLevels}.");
        }

        var block = MintBlockLevel(
            WorldspaceDirectoryHolding(plugin, placement), levels[0], placement.BlockX, placement.BlockY);
        var subBlock = MintBlockLevel(block, levels[1], placement.SubX, placement.SubY);

        return Path.Combine(
            subBlock, LeafNameFor(FormKey.Factory(identity.FormKey), identity.EditorId, isDirectory: true));
    }

    private const int ExteriorBlockLevels = 2;

    // Refuses rather than minting: a worldspace is a record, and only a caller that can mint one
    // through the codec may put it.
    private string WorldspaceDirectoryHolding(PluginKey plugin, CellPlacement placement)
    {
        if (placement.ParentWorldspace is not { } worldspace)
            throw new InvalidOperationException("An exterior cell's placement names no worldspace to place it under.");

        if (FindOwnUnit(Path.Combine(_modFolder, RootFor(plugin.Name)), worldspace) is not { } document)
        {
            throw new InvalidOperationException(
                $"{plugin.Name}'s tree holds no document for worldspace {worldspace}, so an exterior cell " +
                "inside it has nowhere to land.");
        }
        return Path.GetDirectoryName(document)!;
    }

    // Minted only where it is missing, so a second cell into a block level leaves the level's own
    // document exactly as it stands.
    private string MintBlockLevel(string parentDirectory, Type level, int? x, int? y)
    {
        var directory = Path.Combine(parentDirectory, BlockLevelName(x, y));
        if (File.Exists(Path.Combine(directory, GroupRecordDataFileName))) return directory;

        var document = RecordTextCodec.BlankDocument(
            level, _release,
            new JsonObject
            {
                [RecordTypeDispatch.BlockNumberXMember] = x ?? 0,
                [RecordTypeDispatch.BlockNumberYMember] = y ?? 0,
            });
        InMintedDirectory(
            directory, () => WriteTextAtomic(Path.Combine(directory, GroupRecordDataFileName), document));
        return directory;
    }

    // Interior placement carries no gameplay meaning (PlacementWalker records null block/sub for
    // every interior cell), so the bucket already standing is reused and a fresh one minted only the
    // first time.
    private List<string> InteriorCellBlockPathIn(string groupDirectory)
    {
        var levels = RecordTypeDispatch.For(_release).InteriorCellBlockLevels;
        var labels = RecordTypeDispatch.InteriorCellBlockGroupTypes;
        if (levels.Count != labels.Count)
        {
            throw new NotSupportedException(
                $"{_release} nests an interior cell under {levels.Count} block levels, and the source " +
                $"tree's layout has exactly {labels.Count}.");
        }

        // The group's own level has no blank document to ask the codec for: its class has a generated
        // serializer and no deserializer. The compile round-trip gate needs the file, so the empty
        // document stands in.
        InMintedDirectory(groupDirectory, () => WriteIfMissing(groupDirectory, EmptyLevelDocument));

        var path = new List<string>();
        var parent = groupDirectory;
        for (var level = 0; level < levels.Count; level++)
        {
            parent = FindOrMintBlockDirectory(parent, levels[level], labels[level]);
            path.Add(Path.GetFileName(parent));
        }
        return path;
    }

    private static readonly string EmptyLevelDocument = new JsonObject().ToJsonString();

    private static void WriteIfMissing(string directory, string document)
    {
        var path = Path.Combine(directory, GroupRecordDataFileName);
        if (!File.Exists(path)) WriteTextAtomic(path, document);
    }

    // A minted bucket is numbered zero, which the codec's blank document leaves out as the level's
    // own default, so the directory's name and its document agree.
    private string FindOrMintBlockDirectory(string parentDirectory, Type level, string groupType)
    {
        if (Directory.Exists(parentDirectory)
            && Directory.EnumerateDirectories(parentDirectory).FirstOrDefault() is { } standing)
        {
            return standing;
        }

        var directory = Path.Combine(parentDirectory, FirstBlockName);
        var document = RecordTextCodec.BlankDocument(
            level, _release, new JsonObject { [RecordTypeDispatch.GroupTypeMember] = groupType });
        InMintedDirectory(
            directory, () => WriteTextAtomic(Path.Combine(directory, GroupRecordDataFileName), document));
        return directory;
    }

    private const string FirstBlockName = "0";

    /// <summary>Takes back the levels <see cref="LevelsMintedBy"/> named, deepest first, so a parent is
    /// already empty by the time it is reached. A level something else filled stops the walk.</summary>
    internal static void RemoveMintedLevels(IReadOnlyList<string> minted)
    {
        foreach (var stray in minted)
        {
            // Never reached (the create died at an ancestor): skip, so the levels that did land are still
            // removed.
            if (!Directory.Exists(stray)) continue;

            try { Directory.Delete(stray); }
            catch (DirectoryNotFoundException) { /* vanished under us; its ancestors still stand */ }
            catch (IOException) { break; }
            catch (UnauthorizedAccessException) { break; }
        }
    }

    // A relative path read as the layout's own segments: the one place a segment index means anything.
    // source / <plugin> / <group folder> / [block levels] / <record directory> / RecordData.json.
    private sealed class LayoutPath(string relativePath)
    {
        private const int RootSegment = 0;
        private const int PluginSegment = 1;
        private const int GroupFolderSegment = 2;
        private const int HeaderDocumentDepth = 3;
        private const int FlatDocumentDepth = 4;
        private const int ShallowestContainerDocument = 5;

        private readonly string[] _segments =
            relativePath.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);

        internal string PluginFileName => _segments[PluginSegment];

        internal string GroupFolderName => _segments[GroupFolderSegment];

        private string Leaf => _segments[^1];

        private bool UnderTheSourceRoot =>
            _segments.Length > RootSegment && _segments[RootSegment].Equals(RootFolderName, StringComparison.Ordinal);

        private bool NamesAPlugin => _segments.Length > PluginSegment && _segments[PluginSegment].Length > 0;

        internal bool IsHeaderDocument =>
            _segments.Length == HeaderDocumentDepth && UnderTheSourceRoot && NamesAPlugin
            && Leaf.Equals(RecordDataFileName, StringComparison.Ordinal);

        internal bool IsFlatDocument =>
            _segments.Length == FlatDocumentDepth && UnderTheSourceRoot && NamesAPlugin
            && Leaf.EndsWith(JsonSuffix, StringComparison.Ordinal)
            && !Leaf.Equals(RecordDataFileName, StringComparison.Ordinal)
            && !Leaf.Equals(GroupRecordDataFileName, StringComparison.Ordinal);

        // A container's own field file, at its group's own level or deeper.
        internal bool IsContainerDocument =>
            _segments.Length >= ShallowestContainerDocument
            && Leaf.Equals(RecordDataFileName, StringComparison.Ordinal);

        // Below its group's own directory level: an interior cell in a block, an exterior cell in its
        // worldspace's blocks.
        internal bool ContainerIsNested => _segments.Length > ShallowestContainerDocument;

        // A block and a sub-block level sit between a cell's own directory and whatever holds it: its
        // group folder for an interior cell, its worldspace's own directory for an exterior one.
        private const int BlockLevels = 2;

        internal bool UnderGroupBlockLevels =>
            IsContainerDocument && _segments.Length == ShallowestContainerDocument + BlockLevels;

        internal bool UnderWorldspaceBlockLevels =>
            IsContainerDocument && _segments.Length == ShallowestContainerDocument + BlockLevels + 1;

        internal string BlockFolderName => _segments[^4];

        internal string SubBlockFolderName => _segments[^3];

        /// <summary>The worldspace's own directory, for a path <see cref="UnderWorldspaceBlockLevels"/>
        /// answers for: everything above the two block levels and the cell's own directory.</summary>
        internal string WorldspaceDirectory =>
            Path.Combine(_segments[..(ShallowestContainerDocument - 1)]);
    }
}

/// <summary>Two source units under one plugin's tree carry the same FormKey: corruption, not a
/// transient condition. An <see cref="InvalidOperationException"/>: the copy path turns it into a
/// refusal, every other read in Core propagates it unhandled.</summary>
public sealed class AmbiguousSourceUnitException : InvalidOperationException
{
    public AmbiguousSourceUnitException() : base("More than one source unit claims one FormKey.")
    {
    }

    public AmbiguousSourceUnitException(string message) : base(message)
    {
    }

    public AmbiguousSourceUnitException(string message, Exception innerException) : base(message, innerException)
    {
    }
}

using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>Documents by identity over one tracked mod folder (ADR-0014), and ADR-0007's
/// git verbs beneath them. Every verb tolerates the folder having vanished since last observed —
/// MO2's Replace install shell-deletes mod folders.</summary>
public sealed partial class SourceRepository
{
    private readonly string _modFolder;
    private readonly GameRelease _release;
    private readonly SourceRepositoryGit _git;

    /// <summary>The folder this repository is over, for a caller naming a path relative to it.</summary>
    public string ModFolder => _modFolder;

    internal SourceRepositoryLocator Locator { get; }

    internal SourceRepositoryLayout Layout { get; }

    internal SourceRepositoryWrites Writes { get; }

    // Private so a repository comes from one of the two named doors, each stating what it observed:
    // Open, which found a tracked folder, or Over, which established that or did not need it.
    private SourceRepository(string modFolder, GameRelease release)
    {
        (_modFolder, _release) = (modFolder, release);
        _git = new SourceRepositoryGit(modFolder);
        Locator = new SourceRepositoryLocator(modFolder, release);
        Layout = new SourceRepositoryLayout(modFolder, release, Locator);
        Writes = new SourceRepositoryWrites(modFolder, release, Locator, Layout, _git);
    }

    /// <summary>The repository over <paramref name="modFolder"/>, or null when the folder is not
    /// tracked and so has no source tree to answer from. <paramref name="release"/> is the game
    /// whose record types name the tree's group folders.</summary>
    public static SourceRepository? Open(string modFolder, GameRelease release) =>
        IsTracked(modFolder) ? new SourceRepository(modFolder, release) : null;

    /// <summary>The repository over a folder whose tracked state the caller has already established,
    /// or does not need: the document verbs answer either way, and a git verb over an untracked folder
    /// answers empty rather than throwing.</summary>
    public static SourceRepository Over(string root, GameRelease release) => new(root, release);

    /// <summary>True exactly when <paramref name="modFolder"/> holds a repository whose <c>main</c>
    /// exists.</summary>
    public static bool IsTracked(string modFolder) => SourceRepositoryGit.IsTracked(modFolder);

    /// <summary>A repository with history but no <c>main</c>: someone else's, which Track never
    /// writes to (ADR-0003).</summary>
    public static bool HoldsAnotherRepository(string modFolder) => SourceRepositoryGit.HoldsAnotherRepository(modFolder);

    /// <summary>The mod folder only when it is tracked — the single condition under which a plugin
    /// has source text at all.</summary>
    public static string? TrackedModFolderOf(LoadOrderSnapshot loadOrder, PluginAddress plugin) =>
        loadOrder.ModFolderOf(plugin) is { } modFolder && IsTracked(modFolder) ? modFolder : null;

    /// <summary>Whether this folder holds source for the plugin at all: tracked, and a tree written for
    /// this one. A tracked mod folder holds a tree per plugin, and may hold none for a given
    /// plugin.</summary>
    public static bool HoldsTreeFor(string modFolder, string pluginFileName) =>
        IsTracked(modFolder) && Directory.Exists(SourceRepositoryLayout.RootIn(modFolder, pluginFileName));

    /// <summary><c>plugin-source/&lt;pluginFileName&gt;</c>, relative to the mod folder.</summary>
    public static string RootFor(string pluginFileName) => SourceRepositoryLayout.RootFor(pluginFileName);

    /// <summary>The folder holding <paramref name="pluginFileName"/>'s documents. It need not exist:
    /// an untracked mod has none until Track writes one.</summary>
    public static string RootIn(string modFolder, string pluginFileName) =>
        SourceRepositoryLayout.RootIn(modFolder, pluginFileName);

    /// <summary>The plugin header's own document, relative to the mod folder.</summary>
    public static string HeaderDocumentFor(string pluginFileName) => SourceRepositoryLayout.HeaderDocumentFor(pluginFileName);

    /// <summary>One plugin's serialized tree as the files a mod folder holds — what Track and a
    /// re-baseline commit.</summary>
    public static IReadOnlyList<TreeFile> PristineFilesOf(string pluginFileName, IEnumerable<TreeFile> treeFiles) =>
        SourceRepositoryLayout.PristineFilesOf(pluginFileName, treeFiles);

    /// <summary>Throws <see cref="GitUnavailableException"/> when git cannot be run, so no repository
    /// can be made or written here.</summary>
    public static void EnsureTrackable() => SourceRepositoryGit.EnsureOnPath();

    /// <summary>A repository for a mod that has none: <c>Track &lt;mod&gt;</c>, then one baseline commit
    /// per plugin on <c>main</c>, which stays checked out. Answers each plugin whose commit
    /// failed.</summary>
    public static IReadOnlyList<(string Plugin, string Reason)> Track(
        string modFolder, SourcePreset preset,
        IReadOnlyList<(IReadOnlyList<TreeFile> Files, BaselineTrailers Trailers)> baselines) =>
        GitTracking.Track(modFolder, preset, baselines);

    /// <summary>A scratch folder for <paramref name="pluginFileName"/>, outside every mod folder so
    /// a half-written plugin is never mistaken for a tracked one.</summary>
    public static ScratchPlugin ScratchFor(string pluginFileName) => ScratchPlugin.For(pluginFileName);

    /// <summary>The stamp of one document's text, as the UTF-8 the index stores it in: every side hashes
    /// through here, so a file that is not valid UTF-8 stamps alike on disk and in the index.</summary>
    public static string ContentStamp(string text) => TreeStamps.ContentStamp(text);

    /// <summary>The record's own text, or null when no document holds it. The identity comes back as
    /// asked; the body is the tree's answer, spliced out of another record's document when that is
    /// what carries it.</summary>
    public SourceDocument? Get(PluginAddress plugin, RecordIdentity identity)
    {
        if (Locator.Locate(plugin, identity) is not { } unit || !File.Exists(unit.FullPath)) return null;

        var body = DocumentText.RecordBodyFromOwnerBytes(File.ReadAllBytes(unit.FullPath), unit, identity.FormKey, _release);
        return body == null ? null : new SourceDocument(identity.FormKey, identity.RecordType, identity.EditorId, body);
    }

    /// <summary>The record the tree holds at <paramref name="formKey"/>, or null when nothing carries
    /// it. A document named for the key whose text is no document refuses with the reader's words.</summary>
    public SourceDocument? Get(
        PluginAddress plugin, string formKey, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        if (Locator.IdentityOf(plugin, formKey, schemas) is { } identity) return Get(plugin, identity);
        return Locator.UnreadableDocumentFor(plugin, formKey) is { } why
            ? throw new UnreadableSourceDocumentException($"{plugin.Name}'s document for {formKey} is no record document: {why}")
            : null;
    }

    /// <summary>The unit holding <paramref name="identity"/>, as the document it is and the facts about
    /// it. Null when no document in the tree holds it, which is a refusal to the caller.</summary>
    public HoldingUnit? UnitHolding(PluginAddress plugin, RecordIdentity identity) =>
        Locator.Locate(plugin, identity) is { } unit
            ? new HoldingUnit(
                unit.RelativePath, unit.IsEmbedded, unit.OwnerFormKey, unit.OwnerRecordType,
                unit.IsDirectoryPerRecord)
            : null;

    /// <summary>Which record the tree holds at <paramref name="formKey"/> — one with a document of
    /// its own, an embedded child, or the header — or null when nothing carries it.</summary>
    public RecordIdentity? IdentityOf(
        PluginAddress plugin, string formKey, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        Locator.IdentityOf(plugin, formKey, schemas);

    /// <summary>The reader's own words for a document whose name carries <paramref name="formKey"/>
    /// and whose text is not one; null when the tree names no such document.</summary>
    public string? UnreadableDocumentFor(PluginAddress plugin, string formKey) =>
        Locator.UnreadableDocumentFor(plugin, formKey);

    /// <summary>The document carrying <paramref name="identity"/>: its own, else its container's. Null
    /// when no document holds it. Throws <see cref="UnreadableSourceDocumentException"/> when the
    /// document carrying it names no record.</summary>
    public SourceDocument? ContainerDocument(
        PluginAddress plugin, RecordIdentity identity, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        Locator.ContainerDocument(plugin, identity, schemas);

    /// <summary>The record that carries <paramref name="identity"/> inline, and the slot it sits in; null
    /// for a record with a document of its own.</summary>
    public DocumentContainment? ContainerOf(
        PluginAddress plugin, RecordIdentity identity, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        Locator.ContainerOf(plugin, identity, schemas);

    /// <summary>The document holding <paramref name="identity"/>, relative to the mod folder — a
    /// diagnostic's path for the Problems panel. Null when nothing there holds it.</summary>
    public string? RelativePathOf(PluginAddress plugin, RecordIdentity identity) =>
        Locator.Locate(plugin, identity)?.RelativePath;

    /// <summary>Where the tree puts the cell <paramref name="identity"/> names, or null when nothing
    /// holds it. A worldspace document declaring no FormKey throws.</summary>
    public CellPlacement? CellPlacementOf(PluginAddress plugin, RecordIdentity identity) =>
        Locator.CellPlacementOf(plugin, identity);

    /// <summary>The worldspace carrying the cell <paramref name="identity"/> names; null for an interior
    /// cell or one the plugin does not hold. A cell filed under neither refuses with the reader's words.</summary>
    public string? WorldspaceOf(PluginAddress plugin, RecordIdentity identity)
    {
        if (Locator.Locate(plugin, identity) is null) return null;
        if (Locator.CellPlacementOf(plugin, identity) is { } placement) return placement.ParentWorldspace;

        throw new UnreadableSourceDocumentException(
            $"{identity.FormKey} sits under neither a cell group nor a worldspace's blocks, so the tree names no worldspace for it.");
    }

    /// <summary>The exterior cell this plugin's tree holds at grid (<paramref name="x"/>,
    /// <paramref name="y"/>) of <paramref name="worldspace"/>, or null when it holds none there.</summary>
    public SourceDocument? GetCellAt(
        PluginAddress plugin, string worldspace, int x, int y, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        Locator.CellFormKeyAt(plugin, worldspace, x, y) is { } formKey ? Get(plugin, formKey, schemas) : null;

    /// <summary>Every document one plugin's tree holds right now, each as the record at its root. An
    /// embedded child belongs to its owner's document; <see cref="Get(PluginAddress, RecordIdentity)"/> answers with the child's own
    /// text.</summary>
    public IReadOnlyList<SourceDocument> ReadAll(PluginAddress plugin) => Locator.ReadAll(plugin);

    /// <summary>Every EditorID the plugin's tree holds now, a record with a document of its own and
    /// an embedded child alike — what a derived EditorID is checked against to stay unique in the
    /// destination.</summary>
    public IReadOnlySet<string> EditorIdsHeld(PluginAddress plugin) =>
        DocumentTokens.EditorIdsOf(Locator.ReadAll(plugin));

    /// <summary>Every FormKey the plugin's source uses, committed or not: a record's own, an embedded
    /// child's and the header's synthetic one. A deletion frees its key once committed.</summary>
    public IReadOnlySet<string> FormKeysUsed(PluginAddress plugin) =>
        DocumentTokens.FormKeysOf([.. Locator.ReadAll(plugin), .. ReadAllCommitted(plugin)], _release);

    /// <summary>The plugin's tree as the documents it holds right now, each record's own. The caller
    /// disposes it.</summary>
    public IPluginDocuments OpenDocuments(
        PluginAddress plugin, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        new SourceTreeDocuments(_modFolder, plugin.Name, _release, schemas);

    /// <summary>Every file one plugin's source tree holds in the working tree, relative to the mod
    /// folder — the carrier Track hands in, handed back out. Empty when there is no source there.</summary>
    public PluginSourceFiles FilesOf(PluginAddress plugin) => Locator.FilesOf(plugin);

    /// <summary>Which of <paramref name="formKeys"/> more than one document claims. Asked of the
    /// files, not of the compiled mod: the reader's FormKey-keyed RecordCache collapses two documents
    /// in one group folder to the last read.</summary>
    public IReadOnlyList<string> CollidingFormKeys(PluginAddress plugin, IEnumerable<FormKey> formKeys) =>
        PluginSourceChecks.CollidingFormKeys(plugin.Name, Locator.FilesOf(plugin), formKeys);

    /// <summary>Where the source and <paramref name="serialized"/>, the door's tree for the mod it
    /// compiles to, first part ways; null when they match. An unreadable file outranks every other
    /// answer.</summary>
    public SourceDivergence? DivergenceFrom(PluginAddress plugin, IReadOnlyList<TreeFile> serialized) =>
        PluginSourceChecks.DivergenceFrom(plugin.Name, Locator.FilesOf(plugin), serialized);

    /// <summary>One listing of the plugin's tree. A file whose file-system stamp is unchanged and
    /// settled is not read again. A FormKey two documents declare throws
    /// <see cref="AmbiguousSourceUnitException"/>.</summary>
    public RecordStamps StampsOf(PluginAddress plugin) => TreeStamps.StampsOf(_modFolder, plugin);

    /// <summary>Every record the tree holds whose text differs from the last commit's, an embedded
    /// child among them; a tree with no repository is all added. A failed read throws
    /// <see cref="UnreadableSourceDocumentException"/>, never reads as a deletion.</summary>
    public IReadOnlyDictionary<string, RecordChange> ChangedSinceLastCommit(
        PluginAddress plugin, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        LastCommitComparison.Of(_modFolder, _release, _git, Locator, plugin, schemas);

    /// <summary>Creates or replaces the record's document, placing an absent one from its identity
    /// alone and minting the levels above it. A record another document carries is replaced at its
    /// own slot, every other byte untouched.</summary>
    public void Put(PluginAddress plugin, SourceDocument document) => Writes.Put(plugin, document, placement: null);

    /// <summary>The put of an exterior cell, the one record whose directory sits inside another
    /// record's: <paramref name="placement"/> names the worldspace holding it and its block numbers.
    /// Every other record is placed from its identity alone.</summary>
    public void Put(PluginAddress plugin, SourceDocument document, CellPlacement? placement) =>
        Writes.Put(plugin, document, placement);

    /// <summary>The put of an exterior cell, which lands in the block its own grid falls in inside
    /// <paramref name="worldspace"/>'s directory. A cell the plugin already holds is replaced where it is.</summary>
    public void PutInWorldspace(PluginAddress plugin, SourceDocument cell, string worldspace) =>
        Writes.Put(plugin, cell, SourceRepositoryWrites.PlacementIn(worldspace, cell));

    /// <summary>Takes the record out of the tree: its file, its directory, or its element of another
    /// record's document. Already gone is the state asked for; the other two outcomes say what
    /// stopped it.</summary>
    public SourceRemoval Remove(PluginAddress plugin, RecordIdentity identity) => Writes.Remove(plugin, identity);

    /// <summary>The plugin's source in the working tree becomes <paramref name="files"/>, and the
    /// last-compile ref names only the binary they were read from. A failure leaves both as they
    /// were.</summary>
    public void ReplaceSourceFrom(string pluginFileName, IReadOnlyList<TreeFile> files, string binarySha256) =>
        Writes.ReplaceSourceFrom(pluginFileName, files, binarySha256);

    /// <summary>Runs <paramref name="write"/>, which puts the plugin's binary on disk, recording
    /// <paramref name="binarySha256"/> as the one last written. An interrupted write leaves a record
    /// naming the old and the new binary (ADR-0003).</summary>
    public void WriteBinary(PluginAddress plugin, string binarySha256, Action write) =>
        _git.WriteBinary(plugin.Name, binarySha256, write);

    /// <summary>Every binary hash Modbench last wrote for the plugin: one, or several while a write
    /// was interrupted. Empty when none is recorded.</summary>
    public IReadOnlyList<string> LastWrittenBinarySha256s(PluginAddress plugin) =>
        _git.LastWrittenBinarySha256s(plugin.Name);

    private IEnumerable<SourceDocument> ReadAllCommitted(PluginAddress plugin) =>
        _git.BlobsAtRef(plugin.Name, "HEAD")
            .Select(blob => Locator.DocumentAt(blob.RelativePath, blob.Text, plugin.Name))
            .OfType<SourceDocument>();
}

/// <summary>The unit holding a record: the document it is, relative to the mod folder, whose record
/// that document is, and whether it is a directory of its own. One read, so the facts and the path
/// cannot disagree.</summary>
public sealed record HoldingUnit(
    string RelativePath, bool IsEmbedded, string OwnerFormKey, string? OwnerRecordType,
    bool IsDirectoryPerRecord);

/// <summary>Why a record is or is not out of the tree — three states a caller must tell apart, since
/// "no document holds it" and "the owner's own text lacks it" send the author to different
/// places.</summary>
public enum SourceRemoval
{
    /// <summary>The tree does not hold it, including the record that was already gone.</summary>
    Removed,

    /// <summary>Nothing in the tree holds it, so there was nothing to take out.</summary>
    NoDocumentHoldsIt,

    /// <summary>A document was found holding it, but that document's own text does not carry it.</summary>
    OwnerDoesNotCarryIt,
}

/// <summary>One record as the Source tree holds it: its identity and its own text, byte for byte
/// (ADR-0005).</summary>
public sealed record SourceDocument(string FormKey, string RecordType, string? EditorId, string Body)
{
    public RecordIdentity Identity => new(FormKey, RecordType, EditorId);
}

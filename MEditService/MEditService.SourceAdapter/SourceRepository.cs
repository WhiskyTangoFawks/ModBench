using System.Diagnostics.CodeAnalysis;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>Documents by identity over one tracked mod folder (ADR-0014), and ADR-0007's
/// git verbs beneath them. Every verb tolerates the folder having vanished since last observed —
/// MO2's Replace install shell-deletes mod folders.</summary>
public sealed class SourceRepository
{
    private readonly string _modFolder;
    private readonly string _modName;
    private readonly GameRelease _release;
    private readonly SourceRepositoryGit _git;

    internal string ModFolder => _modFolder;

    internal SourceRepositoryLocator Locator { get; }

    internal SourceRepositoryLayout Layout { get; }

    internal SourceRepositoryWrites Writes { get; }

    private SourceRepository(string modFolder, GameRelease release, string modName)
    {
        (_modFolder, _release, _modName) = (modFolder, release, modName);
        _git = new SourceRepositoryGit(modFolder);
        Locator = new SourceRepositoryLocator(modFolder, release);
        Layout = new SourceRepositoryLayout(modFolder, release, Locator);
        Writes = new SourceRepositoryWrites(modFolder, release, Locator, Layout, _git);
    }

    /// <summary>The repository over <paramref name="mod"/>'s folder, or null when the folder is not
    /// tracked and so has no source tree to answer from.</summary>
    public static SourceRepository? Open(PluginProvider.FromMod mod, GameRelease release) =>
        IsTracked(mod.Folder) ? Over(mod, release) : null;

    /// <summary>The repository over a mod's folder, which refuses the last-written record of a plugin
    /// another mod provides (ADR-0012): a repository knows only its folder.</summary>
    public static SourceRepository Over(PluginProvider.FromMod mod, GameRelease release) =>
        new(mod.Folder, release, mod.Name);

    /// <summary>True exactly when <paramref name="modFolder"/> holds a repository whose <c>main</c>
    /// exists.</summary>
    public static bool IsTracked(string modFolder) => SourceRepositoryGit.IsTracked(modFolder);

    /// <summary>A <c>.git</c> with no <c>main</c> that Track did not mark as its own: someone else's, which Track never
    /// writes to (ADR-0003).</summary>
    public static bool HoldsAnotherRepository(string modFolder) => SourceRepositoryGit.HoldsAnotherRepository(modFolder);

    /// <summary>The mod folder only when it is tracked — the single condition under which a plugin
    /// has source text at all.</summary>
    public static PluginProvider.FromMod? TrackedModOf(LoadOrderSnapshot loadOrder, PluginAddress plugin) =>
        loadOrder.ProviderOf(plugin) is PluginProvider.FromMod mod && IsTracked(mod.Folder) ? mod : null;

    /// <summary>Whether this folder holds source for the plugin at all: tracked, and a tree written for
    /// this one. A tracked mod folder holds a tree per plugin, and may hold none for a given
    /// plugin.</summary>
    public static bool HoldsTreeFor(string modFolder, string pluginFileName) =>
        IsTracked(modFolder) && Directory.Exists(SourceRepositoryLayout.RootIn(modFolder, pluginFileName));

    /// <summary>Whether this repository holds a source tree for the plugin.</summary>
    public bool HoldsTreeFor(PluginAddress plugin) => HoldsTreeFor(_modFolder, plugin.Name);

    /// <summary>One plugin's serialized tree as the files a mod folder holds — what Track and
    /// decompile write.</summary>
    public static IReadOnlyList<TreeFile> PristineFilesOf(string pluginFileName, IEnumerable<TreeFile> treeFiles) =>
        SourceRepositoryLayout.PristineFilesOf(pluginFileName, treeFiles);

    /// <summary>Files of <see cref="PristineFilesOf"/> as the whole-mod door reads them.</summary>
    public static IReadOnlyList<TreeFile> DoorFilesOf(
        string pluginFileName, IEnumerable<TreeFile> files, GameRelease gameRelease) =>
        SourceRepositoryLayout.DoorFilesOf(pluginFileName, files, gameRelease);

    /// <summary><paramref name="doorText"/>, the door's words about <paramref name="pluginFileName"/>'s tree,
    /// with the header's file named as the layout names it.</summary>
    public static string SourceTextOf(
        string pluginFileName, string doorText, IEnumerable<TreeFile> files, GameRelease gameRelease) =>
        SourceRepositoryLayout.SourceTextOf(pluginFileName, doorText, files, gameRelease);

    /// <summary>Throws <see cref="GitUnavailableException"/> when git cannot be run, so no repository
    /// can be made or written here.</summary>
    public static void EnsureTrackable() => GitCli.EnsureOnPath();

    /// <summary>A repository for a mod that has none: one commit, <c>Track &lt;mod&gt;</c>, holding every plugin that
    /// tracked, on <c>main</c>, which stays checked out. Answers each plugin whose files could not be written.</summary>
    public static IReadOnlyList<(string Plugin, string Reason)> Track(
        string modFolder, IReadOnlyList<(IReadOnlyList<TreeFile> Files, DecompiledPlugin Plugin)> plugins) =>
        GitTracking.Track(modFolder, plugins);

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

    /// <summary>The document carrying <paramref name="identity"/>: its own, else its container's. Null
    /// when no document holds it. Throws <see cref="UnreadableSourceDocumentException"/> when the
    /// document carrying it names no record.</summary>
    public SourceDocument? ContainerDocument(
        PluginAddress plugin, RecordIdentity identity, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        Locator.ContainerDocument(plugin, identity, schemas);

    /// <summary>The record at <paramref name="formKey"/> and the document carrying it, read from <paramref name="text"/>:
    /// the tree only says which document that is. Null when nothing holds it; text naming no record throws
    /// <see cref="UnreadableSourceDocumentException"/>.</summary>
    public (RecordIdentity Record, SourceDocument Carrying)? CarryingFromText(
        PluginAddress plugin, string formKey, string text, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        Locator.CarryingFromText(plugin, formKey, text, schemas);

    /// <summary>The record that carries <paramref name="identity"/> inline, and the slot it sits in; null
    /// for a record with a document of its own.</summary>
    public DocumentContainment? ContainerOf(
        PluginAddress plugin, RecordIdentity identity, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        Locator.ContainerOf(plugin, identity, schemas);

    /// <summary>The document holding <paramref name="identity"/>, relative to the mod folder — a
    /// diagnostic's path for the Problems panel. Null when nothing there holds it.</summary>
    public string? RelativePathOf(PluginAddress plugin, RecordIdentity identity) =>
        Locator.Locate(plugin, identity)?.RelativePath;

    public string? FullPathOf(PluginAddress plugin, RecordIdentity identity) =>
        Locator.Locate(plugin, identity) is { } unit && File.Exists(unit.FullPath) ? unit.FullPath : null;

    /// <summary>The record whose own document the file at <paramref name="path"/> is, read from its text as the index
    /// reads it; otherwise why the file holds none.</summary>
    public static bool TryRecordOfFile(
        LoadOrderSnapshot loadOrder, string path, [NotNullWhen(true)] out RecordAt? record, [NotNullWhen(false)] out string? whyNone)
    {
        record = null;
        var fullPath = Path.GetFullPath(path);
        if (loadOrder.Plugins.FirstOrDefault(plugin => plugin.Provider is PluginProvider.FromMod mod
                && SourceRepositoryLocator.IsUnder(Path.GetFullPath(SourceRepositoryLayout.RootIn(mod.Folder, plugin.Name)), fullPath)
                && HoldsTreeFor(mod.Folder, plugin.Name)) is not { Provider: PluginProvider.FromMod source } holder)
        {
            whyNone = $"{fullPath} is under no tracked plugin's source.";
            return false;
        }

        if (!Over(source, loadOrder.GameRelease).Locator.TryFormKeyOfFile(holder.Name, fullPath, out var formKey, out whyNone))
            return false;
        record = new RecordAt(holder.Key, formKey);
        return true;
    }

    /// <summary>The name the layout gives the file of the record's own document.</summary>
    public static string FileNameOf(RecordIdentity identity) =>
        SourceRepositoryLayout.FileNameFor(FormKey.Factory(identity.FormKey), identity.EditorId);

    /// <summary>The name of the file in this tree holding <paramref name="identity"/>, whatever it was renamed to; null
    /// when nothing here holds it.</summary>
    public string? FileNameOf(PluginAddress plugin, RecordIdentity identity) =>
        RelativePathOf(plugin, identity) is { } path ? Path.GetFileName(path) : null;

    /// <summary>The worldspace carrying the cell <paramref name="identity"/> names; null for an interior
    /// cell or one the plugin does not hold. A cell filed under neither refuses with the reader's words.</summary>
    public string? WorldspaceOf(PluginAddress plugin, RecordIdentity identity) =>
        CellStructureOf(plugin, identity)?.ParentWorldspace;

    /// <summary>Where the GRUP hierarchy puts the cell <paramref name="identity"/> names; null for one the
    /// plugin does not hold. A cell filed under neither a cell group nor a worldspace refuses with the reader's words.</summary>
    public CellStructure? CellStructureOf(PluginAddress plugin, RecordIdentity identity)
    {
        if (Locator.Locate(plugin, identity) is null) return null;
        return Locator.CellPlacementOf(plugin, identity)?.Structure
            ?? throw new UnreadableSourceDocumentException(
                $"{identity.FormKey} sits under neither a cell group nor a worldspace's blocks, so the tree names no place for it.");
    }

    /// <summary>The exterior cell this plugin's tree holds at grid (<paramref name="x"/>,
    /// <paramref name="y"/>) of <paramref name="worldspace"/>, or null when it holds none there.</summary>
    public SourceDocument? GetCellAt(
        PluginAddress plugin, string worldspace, int x, int y, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        Locator.CellFormKeyAt(plugin, worldspace, x, y) is { } formKey ? Get(plugin, formKey, schemas) : null;

    /// <summary>The FormKey of every cell <paramref name="worldspace"/> holds in this plugin's tree, its
    /// persistent cell and each numbered cell.</summary>
    public IReadOnlyList<string> CellsIn(
        PluginAddress plugin, string worldspace, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        using var documents = OpenDocuments(plugin, schemas);
        return [.. documents.Records
            .Where(document => document.Cell is { IsInterior: false } cell && cell.ParentWorldspace == worldspace)
            .Select(document => document.FormKey)];
    }

    /// <summary>Every EditorID the plugin's tree holds now, a record with a document of its own and
    /// an embedded child alike — what a derived EditorID is checked against to stay unique in the
    /// destination.</summary>
    public IReadOnlySet<string> EditorIdsHeld(PluginAddress plugin) =>
        DocumentTokens.EditorIdsOf(Locator.ReadAll(plugin));

    /// <summary>Every FormKey the plugin's source uses, committed or not: a record's own, an embedded
    /// child's and the header's synthetic one. A deletion frees its key once committed.</summary>
    public IReadOnlySet<string> FormKeysUsed(PluginAddress plugin) =>
        DocumentTokens.FormKeysOf([.. Locator.ReadAll(plugin), .. ReadAllCommitted(plugin)], _release);

    /// <summary>Whether the last commit holds <paramref name="formKey"/> and the tree does not: a
    /// deletion the tree has not committed.</summary>
    public bool HeldOnlyAtLastCommit(PluginAddress plugin, string formKey) =>
        DocumentTokens.FormKeysOf(ReadAllCommitted(plugin), _release).Contains(formKey)
        && !DocumentTokens.FormKeysOf(Locator.ReadAll(plugin), _release).Contains(formKey);

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
        PluginSourceChecks.CollidingFormKeys(plugin.Name, Locator.FilesOf(plugin), formKeys, _release);

    /// <summary>Where the source and <paramref name="serialized"/>, the door's tree, first part ways,
    /// and the files held at another leaf name than the layout's. An unreadable file outranks the rest.</summary>
    public SourceComparison Compare(PluginAddress plugin, IReadOnlyList<TreeFile> serialized) =>
        PluginSourceChecks.Compare(plugin.Name, Locator.FilesOf(plugin), serialized);

    /// <summary>One listing of the plugin's tree. A file whose file-system stamp is unchanged and
    /// settled is not read again.</summary>
    public RecordStamps StampsOf(PluginAddress plugin) => TreeStamps.StampsOf(_modFolder, plugin);

    /// <summary>Every record the tree holds whose text differs from the last commit's, an embedded
    /// child among them; a tree with no repository is all added. A failed read throws
    /// <see cref="UnreadableSourceDocumentException"/>, never reads as a deletion.</summary>
    public IReadOnlyDictionary<string, RecordChange> ChangedSinceLastCommit(
        PluginAddress plugin, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
        LastCommitComparison.Of(_modFolder, _release, _git, Locator, plugin, schemas);

    /// <summary>Creates or replaces the record's document, placing an absent one from its identity
    /// alone with the levels above it. A record another document carries is replaced at its own slot.
    /// A failure writes nothing.</summary>
    public void Put(PluginAddress plugin, SourceDocument document) =>
        Write(plugin, document, () => ChangesToPut(plugin, document));

    /// <summary>The put of an exterior cell, which lands in the block its own grid falls in inside
    /// <paramref name="worldspace"/>'s directory. A held cell is replaced where it is. A failure writes nothing.</summary>
    public void PutInWorldspace(PluginAddress plugin, SourceDocument cell, string worldspace) =>
        Write(plugin, cell, () => ChangesToPutInWorldspace(plugin, cell, worldspace));

    private void Write(PluginAddress plugin, SourceDocument document, Func<SourceChanges> changes)
    {
        Writes.RefuseOverwritingWhatIsNoDocument(plugin, document);
        SourceTransaction.Atomically(this, transaction => transaction.Apply(this, changes()));
    }

    /// <summary>What <see cref="Put"/> changes, written nowhere.</summary>
    public SourceChanges ChangesToPut(PluginAddress plugin, SourceDocument document) => Writes.ChangesToPut(plugin, document);

    /// <summary>What rewriting a document the tree holds changes, written nowhere. One no document holds
    /// throws: an edit never creates.</summary>
    public SourceChanges ChangesToRewrite(PluginAddress plugin, SourceDocument document) => Writes.ChangesToRewrite(plugin, document);

    /// <summary>What <see cref="PutInWorldspace"/> changes, written nowhere.</summary>
    public SourceChanges ChangesToPutInWorldspace(PluginAddress plugin, SourceDocument cell, string worldspace) =>
        Writes.ChangesToPutInWorldspace(plugin, cell, worldspace);

    /// <summary>What changing the FormKey of <paramref name="identity"/> changes, from the text of the document
    /// <paramref name="carrying"/> it, written nowhere. A folder already at the new key's leaf name throws.</summary>
    public SourceChanges ChangesToRekey(
        PluginAddress plugin, SourceDocument carrying, RecordIdentity identity, string newFormKey, DocumentRekey rekey) =>
        Writes.ChangesToRekey(plugin, carrying, identity, newFormKey, rekey);

    /// <summary>Takes the record out of the tree: its file, its directory, or its element of another
    /// record's document. Already gone is the state asked for; the other two outcomes say what
    /// stopped it.</summary>
    public SourceRemoval Remove(PluginAddress plugin, RecordIdentity identity) => Writes.Remove(plugin, identity);

    /// <summary>The plugin's source in the working tree becomes <paramref name="files"/>, and the
    /// last-compile ref names only the binary they were read from. A failure leaves both as they
    /// were.</summary>
    public void ReplaceSourceFrom(PluginAddress plugin, IReadOnlyList<TreeFile> files, string binarySha256)
    {
        RefuseUnlessProvidedByThisMod(plugin);
        Writes.ReplaceSourceFrom(plugin.Name, files, binarySha256);
    }

    /// <summary>The plugin's source and what Modbench last wrote move to <paramref name="newName"/>, and
    /// every FormKey of the plugin follows. False, writing nothing, when a plugin source of the mod holds
    /// that name, compared without case.</summary>
    public bool RenameSource(PluginAddress plugin, string newName)
    {
        RefuseUnlessProvidedByThisMod(plugin);
        var sources = Path.Combine(_modFolder, SourceRepositoryLayout.RootFolderName);
        if (Directory.EnumerateFileSystemEntries(sources)
            .Any(entry => string.Equals(Path.GetFileName(entry), newName, StringComparison.OrdinalIgnoreCase)))
        {
            return false;
        }

        Writes.RenameSource(plugin.Name, newName);
        return true;
    }

    /// <summary>Runs <paramref name="write"/>, recording <paramref name="binarySha256"/> as the one last
    /// written; an interrupted write leaves the old and new (ADR-0003). Git failing before the write
    /// throws with nothing written; after it, false.</summary>
    public bool WriteBinary(PluginAddress plugin, string binarySha256, Action write)
    {
        RefuseUnlessProvidedByThisMod(plugin);
        return _git.WriteBinary(plugin.Name, binarySha256, write);
    }

    /// <summary>Every binary hash Modbench last wrote for the plugin: one, or several while a write
    /// was interrupted. Empty when none is recorded.</summary>
    public IReadOnlyList<string> LastWrittenBinarySha256s(PluginAddress plugin)
    {
        RefuseUnlessProvidedByThisMod(plugin);
        return _git.LastWrittenBinarySha256s(plugin.Name);
    }

    private void RefuseUnlessProvidedByThisMod(PluginAddress plugin)
    {
        if (!string.Equals(plugin.Origin, _modName, StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException(
                $"{plugin.Name} is provided by '{plugin.Origin}', and this repository holds '{_modName}'.", nameof(plugin));
        }
    }

    private IEnumerable<SourceDocument> ReadAllCommitted(PluginAddress plugin) =>
        _git.BlobsAtRef(plugin.Name, "HEAD")
            .Select(blob => Locator.DocumentAt(blob.RelativePath, blob.Text, plugin.Name))
            .OfType<SourceDocument>();
}

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

using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>Documents by identity over one tracked mod folder (ADR-0014), and ADR-0007's
/// git verbs beneath them. Every verb tolerates the folder having vanished since last observed —
/// MO2's Replace install shell-deletes mod folders.</summary>
public sealed class SourceRepository : ISourceRepositoryReads
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

    public static bool IsTracked(RegisteredPlugin plugin) => plugin.Provider is PluginProvider.FromMod mod && IsTracked(mod.Folder);

    /// <summary>The refusal naming the instance root when it is not there; null when it is.</summary>
    public static string? InstanceRootNotFound(string? instanceRoot) =>
        Directory.Exists(instanceRoot) ? null : $"Instance root not found: {instanceRoot}";

    /// <summary>Whether the plugin's source reads: its mod is tracked and holds one tree for it. A tracked mod
    /// holds none for a plugin another tool put there or whose source was deleted.</summary>
    public static bool SourceReads(RegisteredPlugin plugin) =>
        plugin.Provider is PluginProvider.FromMod mod && HoldsTreeFor(mod.Folder, plugin.Name);

    private static bool HoldsTreeFor(string modFolder, string pluginFileName) =>
        IsTracked(modFolder) && SourceRepositoryLayout.TreeNamesIn(modFolder, pluginFileName).Count == 1;

    /// <summary>A <c>.git</c> with no <c>main</c> that Track did not mark as its own: someone else's, which Track never
    /// writes to (ADR-0003).</summary>
    public static bool HoldsAnotherRepository(string modFolder) => SourceRepositoryGit.HoldsAnotherRepository(modFolder);

    /// <summary><paramref name="tree"/>, the whole-mod door's, as <see cref="TreeOf"/> answers it once written:
    /// what a round-trip gate compiles, so that it compiles what is written.</summary>
    public static IReadOnlyList<TreeFile> ReadBackOf(string pluginFileName, IReadOnlyList<TreeFile> tree, GameRelease gameRelease) =>
        SourceRepositoryLayout.DoorTreeOf(pluginFileName, SourceRepositoryLayout.PristineFilesOf(pluginFileName, tree), gameRelease);

    /// <summary>Throws <see cref="GitUnavailableException"/> when git cannot be run, so no repository
    /// can be made or written here.</summary>
    public static void EnsureTrackable() => GitCli.EnsureOnPath();

    /// <summary>A repository for a mod that has none: one commit, <c>Track &lt;mod&gt;</c>, on <c>main</c>, of
    /// each plugin's door tree. Answers each plugin whose files could not be written.</summary>
    public static IReadOnlyList<(string Plugin, string Reason)> Track(
        string modFolder, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins) =>
        GitTracking.Track(modFolder, plugins);

    /// <summary>The stamp of one document's text, as the UTF-8 the index stores it in: every side hashes
    /// through here, so a file that is not valid UTF-8 stamps alike on disk and in the index.</summary>
    public static string ContentStamp(string text) => TreeStamps.ContentStamp(text);

    /// <summary>The record's own text, or null when no document holds it. The identity comes back as
    /// asked; the body is the tree's answer, spliced out of another record's document when that is
    /// what carries it.</summary>
    public SourceDocument? RecordOf(PluginAddress plugin, RecordIdentity identity)
    {
        if (Locator.Locate(InTreeSpelling(plugin), identity) is not { } unit || !File.Exists(unit.FullPath)) return null;

        var body = DocumentText.RecordBodyFromOwnerBytes(File.ReadAllBytes(unit.FullPath), unit, identity.FormKey, _release);
        return body == null ? null : new SourceDocument(identity.FormKey, identity.RecordType, identity.EditorId, body);
    }

    /// <summary>The record the tree holds at <paramref name="formKey"/>, or null when nothing carries
    /// it. A document named for the key whose text is no document refuses with the reader's words.</summary>
    public SourceDocument? Get(
        PluginAddress plugin, string formKey)
    {
        var spelled = InTreeSpelling(plugin);
        if (Locator.IdentityOf(spelled, formKey) is { } identity) return RecordOf(spelled, identity);
        return Locator.UnreadableDocumentFor(spelled, formKey) is { } why
            ? throw new UnreadableSourceDocumentException($"{plugin.Name}'s document for {formKey} is no record document: {why}")
            : null;
    }

    /// <summary>Throws <see cref="UnreadableSourceDocumentException"/>, naming the file that carries
    /// <paramref name="identity"/>, when <paramref name="body"/> holds what reading the whole tree
    /// refuses.</summary>
    public void RefuseUnreadable(
        PluginAddress plugin, RecordIdentity identity, string body)
    {
        var spelled = InTreeSpelling(plugin);
        if (Locator.Locate(spelled, identity) is not { } unit) return;
        using var documents = new SourceTreeDocuments(_modFolder, spelled.Name, _release);
        documents.RefuseUnreadable(identity.RecordType, identity.FormKey, body, unit.FullPath);
    }

    /// <summary>The record at <paramref name="formKey"/> and the document carrying it, read from <paramref name="text"/>:
    /// the tree only says which document that is. Null when nothing holds it; text naming no record throws
    /// <see cref="UnreadableSourceDocumentException"/>.</summary>
    public (RecordIdentity Record, SourceDocument Carrying)? CarryingFromText(
        PluginAddress plugin, string formKey, string text) =>
        Locator.CarryingFromText(InTreeSpelling(plugin), formKey, text);

    /// <summary>The record at <paramref name="formKey"/> with its own text read out of <paramref name="text"/>, the
    /// document carrying it by <see cref="CarryingFromText"/>'s rule. Null and throws as that does.</summary>
    public SourceDocument? RecordFromText(
        PluginAddress plugin, string formKey, string text)
    {
        if (CarryingFromText(plugin, formKey, text) is not var (record, carrying)) return null;
        if (FormKey.TryFactory(carrying.FormKey, out var declared) && declared == FormKey.Factory(record.FormKey))
            return new SourceDocument(record.FormKey, record.RecordType, record.EditorId, text);

        var bytes = Encoding.UTF8.GetBytes(text);
        var body = EmbeddedChildSplice.TextOf(bytes, carrying.RecordType, record.FormKey, _release)
            ?? throw new InvalidOperationException($"Expected the text CarryingFromText found carrying {record.FormKey} to hold it.");
        return new SourceDocument(record.FormKey, record.RecordType, record.EditorId, body);
    }

    /// <summary>The record that carries <paramref name="identity"/> inline, and the slot it sits in; null
    /// for a record with a document of its own.</summary>
    public DocumentContainment? ContainerOf(
        PluginAddress plugin, RecordIdentity identity) =>
        Locator.ContainerOf(InTreeSpelling(plugin), identity);

    /// <summary>The document holding <paramref name="identity"/>, relative to the mod folder — a
    /// diagnostic's path for the Problems panel. Null when nothing there holds it.</summary>
    public string? RelativePathOf(PluginAddress plugin, RecordIdentity identity) =>
        Locator.Locate(InTreeSpelling(plugin), identity)?.RelativePath;

    /// <summary>The file in this tree holding <paramref name="identity"/>; null when nothing there holds it.</summary>
    public DocumentFile? DocumentOf(PluginAddress plugin, RecordIdentity identity) =>
        Locator.Locate(InTreeSpelling(plugin), identity) is { } unit && File.Exists(unit.FullPath) ? new DocumentFile(unit.FullPath, unit.IsEmbedded) : null;

    /// <summary>What the file at <paramref name="path"/> holds, read from its text as the index reads it.</summary>
    internal static RecordOfFileAnswer RecordOfFile(LoadOrderSnapshot loadOrder, string path)
    {
        var fullPath = Path.GetFullPath(path);
        if (SourceRepositoryLayout.CarriesNoRecord(fullPath)) return new RecordOfFileAnswer.HoldsNone();
        if (loadOrder.Plugins.FirstOrDefault(plugin => plugin.Provider is PluginProvider.FromMod mod
                && SourceRepositoryLocator.IsUnder(Path.GetFullPath(SourceRepositoryLayout.RootIn(mod.Folder, TreeNameOf(mod.Folder, plugin.Name))), fullPath)
                && SourceReads(plugin)) is not { Provider: PluginProvider.FromMod source } holder)
            return new RecordOfFileAnswer.Refused($"{fullPath} is under no tracked plugin's source.");

        return Over(source, loadOrder.GameRelease).Locator.RecordOfFile(holder.Key, TreeNameOf(source.Folder, holder.Name), fullPath);
    }

    /// <summary>The name the layout gives the file of the record's own document.</summary>
    internal static string FileNameOf(RecordIdentity identity) =>
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
        var spelled = InTreeSpelling(plugin);
        if (Locator.Locate(spelled, identity) is null) return null;
        return Locator.CellPlacementOf(spelled, identity)?.Structure
            ?? throw new UnreadableSourceDocumentException(
                $"{identity.FormKey} sits under neither a cell group nor a worldspace's blocks, so the tree names no place for it.");
    }

    /// <summary>The exterior cell this plugin's tree holds at grid (<paramref name="x"/>,
    /// <paramref name="y"/>) of <paramref name="worldspace"/>, or null when it holds none there.</summary>
    public SourceDocument? GetCellAt(
        PluginAddress plugin, string worldspace, int x, int y) =>
        Locator.CellFormKeyAt(InTreeSpelling(plugin), worldspace, x, y) is { } formKey ? Get(plugin, formKey) : null;

    /// <summary>Every EditorID the plugin's tree holds now, a record with a document of its own and
    /// an embedded child alike — what a derived EditorID is checked against to stay unique in the
    /// destination.</summary>
    public IReadOnlySet<string> EditorIdsHeld(PluginAddress plugin) =>
        DocumentTokens.EditorIdsOf(Locator.ReadAll(InTreeSpelling(plugin)));

    /// <summary>Every FormKey the plugin's working tree uses: a record's own, an embedded child's and the
    /// header's synthetic one.</summary>
    public IReadOnlySet<string> FormKeysUsed(PluginAddress plugin) =>
        DocumentTokens.FormKeysOf(Locator.ReadAll(InTreeSpelling(plugin)), _release);

    /// <summary>The plugin's tree as the documents it holds right now, each record's own. The caller
    /// disposes it.</summary>
    public IPluginDocuments OpenDocuments(
        PluginAddress plugin) =>
        new SourceTreeDocuments(_modFolder, InTreeSpelling(plugin).Name, _release);

    /// <summary>The plugin's source in the working tree as the whole-mod door reads it, empty when there is
    /// none. A directory holding several documents, none named for it, throws
    /// <see cref="AmbiguousSourceUnitException"/>.</summary>
    public PluginSourceFiles TreeOf(PluginAddress plugin)
    {
        var spelled = InTreeSpelling(plugin);
        var held = Locator.FilesOf(spelled);
        return held with { Files = SourceRepositoryLayout.DoorTreeOf(spelled.Name, held.Files, _release) };
    }

    /// <summary><paramref name="diagnosis"/> of a read of <see cref="TreeOf"/>'s tree, each file it names
    /// named as this tree holds it, relative to the mod folder.</summary>
    public PluginDiagnosis InSourceNames(PluginAddress plugin, PluginDiagnosis diagnosis)
    {
        var spelled = InTreeSpelling(plugin);
        return SourceRepositoryLayout.InSourceNames(spelled.Name, diagnosis, Locator.FilesOf(spelled).Files, _release);
    }

    /// <summary>Which of <paramref name="formKeys"/> more than one document claims. Asked of the
    /// files, not of the compiled mod: the reader's FormKey-keyed RecordCache collapses two documents
    /// in one group folder to the last read.</summary>
    public IReadOnlyList<string> CollidingFormKeys(PluginAddress plugin, IEnumerable<FormKey> formKeys)
    {
        var spelled = InTreeSpelling(plugin);
        return PluginSourceChecks.CollidingFormKeys(spelled.Name, Locator.FilesOf(spelled), formKeys, _release);
    }

    /// <summary>Where the source and <paramref name="serialized"/>, the whole-mod door's tree, first part ways,
    /// and the files held at another leaf name than the layout's. An unreadable file outranks the rest.</summary>
    public SourceComparison Compare(PluginAddress plugin, IReadOnlyList<TreeFile> serialized)
    {
        var spelled = InTreeSpelling(plugin);
        return PluginSourceChecks.Compare(spelled.Name, Locator.FilesOf(spelled), serialized);
    }

    /// <summary>One listing of the plugin's tree. A file whose file-system stamp is unchanged and
    /// settled is not read again.</summary>
    public RecordStamps StampsOf(PluginAddress plugin) => TreeStamps.StampsOf(_modFolder, InTreeSpelling(plugin));

    /// <summary>Every record the tree holds whose text differs from the last commit's, an embedded
    /// child among them; a tree with no repository is all added. A failed read throws
    /// <see cref="UnreadableSourceDocumentException"/>, never reads as a deletion.</summary>
    public IReadOnlyDictionary<string, RecordChange> ChangedSinceLastCommit(
        PluginAddress plugin) =>
        LastCommitComparison.Of(_modFolder, _release, _git, Locator, InTreeSpelling(plugin));

    /// <summary>Creates or replaces the record's document, placing an absent one from its identity
    /// alone with the levels above it. A record another document carries is replaced at its own slot.
    /// A failure writes nothing.</summary>
    public void Put(PluginAddress plugin, SourceDocument document) =>
        SourceTransaction.Atomically(this, transaction => transaction.Apply(ChangesToPut(plugin, document)));

    /// <summary>What <see cref="Put"/> changes, written nowhere. A file at its path that is no document throws
    /// as unreadable.</summary>
    public SourceChanges ChangesToPut(PluginAddress plugin, SourceDocument document) => Writes.ChangesToPut(InTreeSpelling(plugin), document);

    /// <summary>What rewriting a document the tree holds changes, written nowhere. One no document holds
    /// throws: an edit never creates.</summary>
    public SourceChanges ChangesToRewrite(PluginAddress plugin, SourceDocument document) => Writes.ChangesToRewrite(InTreeSpelling(plugin), document);

    /// <summary>What putting an exterior cell changes, written nowhere: a new cell lands in its grid's block
    /// under <paramref name="worldspace"/>, a held one where it is. A file there that is no document throws
    /// as unreadable.</summary>
    public SourceChanges ChangesToPutInWorldspace(PluginAddress plugin, SourceDocument cell, string worldspace) =>
        Writes.ChangesToPutInWorldspace(InTreeSpelling(plugin), cell, worldspace);

    /// <summary>What changing the FormKey of <paramref name="identity"/> changes, from the text of the document
    /// <paramref name="carrying"/> it, written nowhere. A folder already at the new key's leaf name throws.</summary>
    public SourceChanges ChangesToRekey(
        PluginAddress plugin, SourceDocument carrying, RecordIdentity identity, string newFormKey, DocumentRekey rekey) =>
        Writes.ChangesToRekey(InTreeSpelling(plugin), carrying, identity, newFormKey, rekey);

    /// <summary>Takes the record out of the tree: its file, its directory, or its element of another
    /// record's document. Already gone is the state asked for; the other two outcomes say what
    /// stopped it.</summary>
    public SourceRemoval Remove(PluginAddress plugin, RecordIdentity identity) => Writes.Remove(InTreeSpelling(plugin), identity);

    /// <summary>The plugin's source in the working tree becomes <paramref name="tree"/>, the whole-mod door's,
    /// and the last-compile ref names only the binary it was read from. A failure leaves both as they
    /// were.</summary>
    public void ReplaceSourceFrom(PluginAddress plugin, IReadOnlyList<TreeFile> tree, string binarySha256)
    {
        var name = ProvidedByThisMod(plugin).Name;
        Writes.ReplaceSourceFrom(name, SourceRepositoryLayout.PristineFilesOf(name, tree), binarySha256);
    }

    /// <summary>The plugin's source and what Modbench last wrote move to <paramref name="newName"/>, and
    /// every FormKey of the plugin follows. False, writing nothing, when a plugin source of the mod holds
    /// that name, compared without case.</summary>
    public bool RenameSource(PluginAddress plugin, string newName)
    {
        var name = ProvidedByThisMod(plugin).Name;
        var sources = Path.Combine(_modFolder, SourceRepositoryLayout.RootFolderName);
        if (Directory.EnumerateFileSystemEntries(sources)
            .Any(entry => string.Equals(Path.GetFileName(entry), newName, StringComparison.OrdinalIgnoreCase)))
        {
            return false;
        }

        Writes.RenameSource(name, newName);
        return true;
    }

    /// <summary>Runs <paramref name="write"/>, recording <paramref name="binarySha256"/> as the one last
    /// written; an interrupted write leaves the old and new (ADR-0003). Git failing before the write
    /// throws with nothing written; after it, false.</summary>
    public bool WriteBinary(PluginAddress plugin, string binarySha256, Action write) =>
        _git.WriteBinary(ProvidedByThisMod(plugin).Name, binarySha256, write);

    /// <summary>Every binary hash Modbench last wrote for the plugin: one, or several while a write
    /// was interrupted. Empty when none is recorded.</summary>
    public IReadOnlyList<string> LastWrittenBinarySha256s(PluginAddress plugin) =>
        _git.LastWrittenBinarySha256s(ProvidedByThisMod(plugin).Name);

    private PluginAddress ProvidedByThisMod(PluginAddress plugin)
    {
        if (!string.Equals(plugin.Origin, _modName, StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException(
                $"{plugin.Name} is provided by '{plugin.Origin}', and this repository holds '{_modName}'.", nameof(plugin));
        }
        return InTreeSpelling(plugin);
    }

    // A plugin's name compares without case, as a ModKey's does, so its tree is read and written as its folder
    // spells it. Two folders differing in case leave it as given: SourceReads refuses those.
    private PluginAddress InTreeSpelling(PluginAddress plugin) => plugin with { Name = TreeNameOf(_modFolder, plugin.Name) };

    private static string TreeNameOf(string modFolder, string pluginFileName) =>
        SourceRepositoryLayout.TreeNamesIn(modFolder, pluginFileName) is [var name] ? name : pluginFileName;
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

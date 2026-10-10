using System.Text;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>Documents by identity over one tracked mod folder (ADR-0014), and ADR-0007's
/// git verbs beneath them. Every verb tolerates the folder having vanished since last observed —
/// MO2's Replace install shell-deletes mod folders.</summary>
public sealed class SourceRepository : ISourceRepository
{
    private readonly string _modFolder;
    private readonly string _modName;
    private readonly GameRelease _release;
    private readonly SourceRepositoryGit _git;

    public string ModFolder => _modFolder;

    internal SourceRepositoryLocator Locator { get; }

    internal SourceRepositoryLayout Layout { get; }

    internal SourceRepositoryWrites Writes { get; }

    internal ISourceFiles Files { get; }

    private SourceRepository(string modFolder, GameRelease release, string modName, ISourceFiles files)
    {
        (_modFolder, _release, _modName, Files) = (modFolder, release, modName, files);
        _git = new SourceRepositoryGit(modFolder);
        Locator = new SourceRepositoryLocator(modFolder, release, files);
        Layout = new SourceRepositoryLayout(modFolder, release, Locator, files);
        Writes = new SourceRepositoryWrites(modFolder, release, Locator, Layout, _git, files);
    }

    /// <summary>This repository read through <paramref name="files"/>.</summary>
    internal SourceRepository Over(ISourceFiles files) => new(_modFolder, _release, _modName, files);

    /// <summary>The repository over <paramref name="mod"/>'s folder, or null when the folder is not
    /// tracked and so has no source tree to answer from.</summary>
    public static SourceRepository? Open(PluginProvider.FromMod mod, GameRelease release) =>
        IsTracked(mod.Folder) ? Over(mod, release) : null;

    /// <summary>The repository over a mod's folder, which refuses the last-written record of a plugin
    /// another mod provides (ADR-0012): a repository knows only its folder.</summary>
    public static SourceRepository Over(PluginProvider.FromMod mod, GameRelease release) =>
        new(mod.Folder, release, mod.Name, DiskFiles.Instance);

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
        IsTracked(modFolder) && SourceRepositoryLayout.TreeNameIn(modFolder, pluginFileName).Holds(out _, out _);

    /// <summary>Why the plugin's source does not read though its mod is tracked: no folder, twin folders, or a plugin
    /// source that cannot be listed. Null when it reads, and when its mod is not tracked.</summary>
    public static SourceFailure? WhySourceDoesNotRead(RegisteredPlugin plugin) =>
        plugin.Provider is PluginProvider.FromMod mod && IsTracked(mod.Folder)
        && !SourceRepositoryLayout.TreeNameIn(mod.Folder, plugin.Name).Holds(out _, out var why)
            ? why
            : null;

    /// <summary>A <c>.git</c> with no <c>main</c> that Track did not mark as its own: someone else's, which Track never
    /// writes to (ADR-0003).</summary>
    public static bool HoldsAnotherRepository(string modFolder) => SourceRepositoryGit.HoldsAnotherRepository(modFolder);

    /// <summary><paramref name="tree"/>, the whole-mod door's, as <see cref="TreeOf"/> answers it once written:
    /// what a round-trip gate compiles, so that it compiles what is written.</summary>
    public static IReadOnlyList<TreeFile> ReadBackOf(string pluginFileName, IReadOnlyList<TreeFile> tree, GameRelease gameRelease) =>
        SourceFailure.Answer(() => SourceRepositoryLayout.DoorTreeOf(
                pluginFileName, SourceRepositoryLayout.PristineFilesOf(pluginFileName, tree), gameRelease))
            .Holds(out var readBack, out var failure)
            ? readBack
            : throw new InvalidOperationException($"Expected the whole-mod door to write one document per container: {failure.Reason}");

    /// <summary>Why git cannot be run here, so no repository can be made or written; null when it can.</summary>
    public static SourceFailure? WhyGitCannotRun() => SourceFailure.Answer(GitCli.EnsureOnPath);

    /// <summary>A repository for a mod that has none: one commit, <c>Track &lt;mod&gt;</c>, on <c>main</c>, of
    /// each plugin's door tree. Answers each plugin refused, every one when no repository was made.</summary>
    public static IReadOnlyList<(string Plugin, string Reason)> Track(
        string modFolder, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins) =>
        SourceFailure.Answer(() => GitTracking.Track(modFolder, plugins)).Holds(out var refused, out var failure)
            ? refused
            : [.. plugins.Select(plugin => (plugin.Plugin.Plugin, failure.Reason))];

    /// <summary>Forgets the listings and scans taken so far, for a tree that something else has since changed.</summary>
    public void ForgetWhatItRead() => Locator.Forget();

    /// <summary>The stamp of one document's text, as the UTF-8 the index stores it in: every side hashes
    /// through here, so a file that is not valid UTF-8 stamps alike on disk and in the index.</summary>
    public static string ContentStamp(string text) => TreeStamps.ContentStamp(text);

    /// <summary>The record's own text, or null when no document holds it. The identity comes back as
    /// asked; the body is the tree's answer, spliced out of another record's document when that is
    /// what carries it.</summary>
    public Answer<SourceDocument?, SourceFailure> RecordOf(PluginAddress plugin, RecordIdentity identity) =>
        SourceFailure.Answer(() => OwnTextOf(Spelled(plugin), identity));

    private SourceDocument? OwnTextOf(PluginAddress spelled, RecordIdentity identity)
    {
        if (Locator.Locate(spelled, identity) is not { } unit || !Files.FileExists(unit.FullPath)) return null;

        var body = DocumentText.RecordBodyFromOwnerBytes(Files.ReadAllBytes(unit.FullPath), unit, identity.FormKey, _release);
        return body == null ? null : new SourceDocument(identity.FormKey, identity.RecordType, identity.EditorId, body);
    }

    public Answer<SourceDocument?, SourceFailure> RecordByFormKey(PluginAddress plugin, string formKey) =>
        SourceFailure.Answer(() => Held(Spelled(plugin), formKey));

    private SourceDocument? Held(PluginAddress spelled, string formKey)
    {
        if (Locator.IdentityOf(spelled, formKey) is { } identity) return OwnTextOf(spelled, identity);
        return Locator.UnreadableDocumentFor(spelled, formKey) is { } why
            ? throw SourceStopException.Unreadable($"{spelled.Name}'s document for {formKey} is no record document: {why}")
            : null;
    }

    /// <summary>Why <paramref name="body"/>, the text of the document carrying <paramref name="identity"/>, holds
    /// what reading the whole tree refuses; null when it reads.</summary>
    public SourceFailure? WhyUnreadable(PluginAddress plugin, RecordIdentity identity, string body) =>
        SourceFailure.Answer(() =>
        {
            var spelled = Spelled(plugin);
            if (DocumentTokens.WhyNotADocument(body) is not null)
            {
                throw SourceStopException.Unreadable(
                    $"The source of {identity.FormKey} in {plugin.Name} ({plugin.Origin}) is not a readable document.");
            }
            if (Locator.Locate(spelled, identity) is not { } unit) return;
            using var documents = new SourceTreeDocuments(_modFolder, spelled.Name, _release, Files);
            documents.RefuseUnreadable(identity.RecordType, identity.FormKey, body, unit.FullPath);
        });

    private Answer<(RecordIdentity Record, SourceDocument Carrying)?, SourceFailure> CarryingFromText(
        PluginAddress plugin, string formKey, string text) =>
        SourceFailure.Answer(() => Locator.CarryingFromText(Spelled(plugin), formKey, text));

    /// <summary>The record at <paramref name="formKey"/> with its own text read out of <paramref name="text"/>, the
    /// document holding it by the rule of that document, and answering as that does.</summary>
    public Answer<SourceDocument?, SourceFailure> RecordFromText(PluginAddress plugin, string formKey, string text) =>
        CarryingFromText(plugin, formKey, text).Then(found =>
            SourceAnswer.Of(found is var (record, carrying) ? OwnTextIn(text, record, carrying) : null));

    private SourceDocument OwnTextIn(string text, RecordIdentity record, SourceDocument carrying)
    {
        if (FormKey.TryFactory(carrying.FormKey, out var declared) && declared == FormKey.Factory(record.FormKey))
            return new SourceDocument(record.FormKey, record.RecordType, record.EditorId, text);

        var body = ContainerDocumentEdits.ChildTextOf(Encoding.UTF8.GetBytes(text), carrying.RecordType, record.FormKey, _release)
            ?? throw new InvalidOperationException($"Expected the text CarryingFromText found carrying {record.FormKey} to hold it.");
        return new SourceDocument(record.FormKey, record.RecordType, record.EditorId, body);
    }

    public Answer<DocumentContainment?, SourceFailure> ContainerOf(PluginAddress plugin, RecordIdentity identity) =>
        SourceFailure.Answer(() => Locator.ContainerOf(Spelled(plugin), identity));

    /// <summary>The document holding <paramref name="identity"/>, relative to the mod folder — a
    /// diagnostic's path for the Problems panel. Null when nothing there holds it.</summary>
    public Answer<string?, SourceFailure> RelativePathOf(PluginAddress plugin, RecordIdentity identity) =>
        SourceFailure.Answer(() => Locator.Locate(Spelled(plugin), identity)?.RelativePath);

    /// <summary>The file in this tree holding <paramref name="identity"/>; null when nothing there holds it.</summary>
    public Answer<DocumentFile?, SourceFailure> DocumentOf(PluginAddress plugin, RecordIdentity identity) =>
        SourceFailure.Answer(() => Locator.Locate(Spelled(plugin), identity) is { } unit && Files.FileExists(unit.FullPath)
            ? new DocumentFile(unit.FullPath, unit.IsEmbedded)
            : null);

    /// <summary>What the file at <paramref name="path"/> holds, read from its text as the index reads it.</summary>
    internal static RecordOfFileAnswer RecordOfFile(LoadOrderSnapshot loadOrder, string path, ISourceFiles files)
    {
        var fullPath = Path.GetFullPath(path);
        if (SourceRepositoryLayout.CarriesNoRecord(fullPath)) return new RecordOfFileAnswer.HoldsNone();
        foreach (var plugin in loadOrder.Plugins)
        {
            if (plugin.Provider is PluginProvider.FromMod mod && TreeFolderHolding(plugin, fullPath) is { } tree)
                return Over(mod, loadOrder.GameRelease).Over(files).Locator.RecordOfFile(plugin.Key, tree, fullPath);
        }
        return new RecordOfFileAnswer.Refused($"{fullPath} is under no tracked plugin's source.");
    }

    internal static bool TreeHolds(RegisteredPlugin plugin, string fullPath) => TreeFolderHolding(plugin, fullPath) is not null;

    private static string? TreeFolderHolding(RegisteredPlugin plugin, string fullPath) =>
        plugin.Provider is PluginProvider.FromMod mod
        && SourceRepositoryLayout.TreeFolderHolding(mod.Folder, fullPath) is { } tree
        && tree.Equals(plugin.Name, StringComparison.OrdinalIgnoreCase)
        && IsTracked(mod.Folder)
        && SourceRepositoryLayout.TreeNameIn(mod.Folder, plugin.Name).Holds(out var named, out _)
        && string.Equals(named, tree, SourceRepositoryLocator.PathComparison)
            ? tree
            : null;

    /// <summary>The name the layout gives the file of the record's own document.</summary>
    internal static string FileNameOf(RecordIdentity identity) =>
        SourceRepositoryLayout.FileNameFor(FormKey.Factory(identity.FormKey), identity.EditorId);

    /// <summary>The name of the file in this tree holding <paramref name="identity"/>, whatever it was renamed to; null
    /// when nothing here holds it.</summary>
    public Answer<string?, SourceFailure> FileNameOf(PluginAddress plugin, RecordIdentity identity) =>
        RelativePathOf(plugin, identity).Then(path => SourceAnswer.Of(path is null ? null : Path.GetFileName(path)));

    public Answer<string?, SourceFailure> WorldspaceOf(PluginAddress plugin, RecordIdentity identity) =>
        CellStructureOf(plugin, identity).Then(cell => SourceAnswer.Of(cell?.ParentWorldspace));

    public Answer<CellStructure?, SourceFailure> CellStructureOf(PluginAddress plugin, RecordIdentity identity) =>
        SourceFailure.Answer<CellStructure?>(() =>
        {
            var spelled = Spelled(plugin);
            if (Locator.Locate(spelled, identity) is null) return null;
            return Locator.CellPlacementOf(spelled, identity)?.Structure
                ?? throw SourceStopException.Unreadable(
                    $"{identity.FormKey} sits under neither a cell group nor a worldspace's blocks, so the tree names no place for it.");
        });

    public Answer<SourceDocument?, SourceFailure> GetCellAt(PluginAddress plugin, string worldspace, int x, int y) =>
        SourceFailure.Answer(() =>
        {
            var spelled = Spelled(plugin);
            return Locator.CellFormKeyAt(spelled, worldspace, x, y) is { } formKey ? Held(spelled, formKey) : null;
        });

    public Answer<IReadOnlySet<string>, SourceFailure> EditorIdsHeld(PluginAddress plugin) =>
        SourceFailure.Answer<IReadOnlySet<string>>(() => EditorIdsOf(Locator.ReadAll(Spelled(plugin))));

    public Answer<IReadOnlySet<string>, SourceFailure> FormKeysUsed(PluginAddress plugin) =>
        SourceFailure.Answer<IReadOnlySet<string>>(() => FormKeysOf(Locator.ReadAll(Spelled(plugin))));

    private HashSet<string> FormKeysOf(IEnumerable<SourceDocument> documents)
    {
        var keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var document in documents)
        {
            keys.Add(document.FormKey);

            // A child inlined in this document is a record of its own with a FormKey of its own, so its
            // ID is as taken as any other.
            foreach (var (formKey, position) in DocumentTokens.FormKeysIn(Encoding.UTF8.GetBytes(document.Body), _release))
            {
                if (position == FormKeyPosition.Embedded) keys.Add(formKey);
            }
        }
        return keys;
    }

    private static HashSet<string> EditorIdsOf(IEnumerable<SourceDocument> documents)
    {
        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var document in documents)
        {
            foreach (var editorId in DocumentTokens.EditorIdsIn(Encoding.UTF8.GetBytes(document.Body)))
                ids.Add(editorId ?? throw new InvalidOperationException($"{document.FormKey}'s document reached EditorIdsOf unread."));
        }
        return ids;
    }

    /// <summary>What <paramref name="read"/> makes of the plugin's tree, streamed as each record's own
    /// document. One the stream cannot read stops <paramref name="read"/>, and the answer is why.</summary>
    public Answer<T, SourceFailure> ReadDocuments<T>(PluginAddress plugin, Func<IPluginDocuments, T> read) =>
        SourceFailure.Answer(() =>
        {
            using var documents = new SourceTreeDocuments(_modFolder, Spelled(plugin).Name, _release, Files);
            return read(documents);
        });

    public Answer<PluginSourceFiles, SourceFailure> TreeOf(PluginAddress plugin) =>
        SourceFailure.Answer(() =>
        {
            var spelled = Spelled(plugin);
            var held = Locator.FilesOf(spelled);
            return held with { Files = SourceRepositoryLayout.DoorTreeOf(spelled.Name, held.Files, _release) };
        });

    public Answer<PluginDiagnosis, SourceFailure> InSourceNames(PluginAddress plugin, PluginDiagnosis diagnosis) =>
        SourceFailure.Answer(() =>
        {
            var spelled = Spelled(plugin);
            return SourceRepositoryLayout.InSourceNames(spelled.Name, diagnosis, Locator.FilesOf(spelled).Files, _release);
        });

    public Answer<IReadOnlyList<string>, SourceFailure> CollidingFormKeys(PluginAddress plugin, IEnumerable<FormKey> formKeys) =>
        SourceFailure.Answer(() =>
        {
            var spelled = Spelled(plugin);
            return PluginSourceChecks.CollidingFormKeys(spelled.Name, Locator.FilesOf(spelled), formKeys, _release);
        });

    public Answer<SourceComparison, SourceFailure> Compare(PluginAddress plugin, IReadOnlyList<TreeFile> serialized) =>
        SourceFailure.Answer(() =>
        {
            var spelled = Spelled(plugin);
            return PluginSourceChecks.Compare(spelled.Name, Locator.FilesOf(spelled), serialized);
        });

    /// <summary>One listing of the plugin's tree. A file whose file-system stamp is unchanged and
    /// settled is not read again, unless an unsaved text stands in for it.</summary>
    public RecordStamps StampsOf(PluginAddress plugin) => TreeStamps.StampsOf(_modFolder, Spelled(plugin), Files);

    /// <summary>Every record the tree holds whose text differs from the last commit's, an embedded
    /// child among them; a tree with no repository is all added. A failed read answers why, never
    /// reads as a deletion.</summary>
    public Answer<IReadOnlyDictionary<string, RecordChange>, SourceFailure> ChangedSinceLastCommit(PluginAddress plugin) =>
        SourceFailure.Answer(() => LastCommitComparison.Of(_modFolder, _release, _git, Locator, Spelled(plugin)));

    public Answer<SourceChanges, SourceFailure> ChangesToPut(PluginAddress plugin, SourceDocument document) =>
        SourceFailure.Answer(() => Writes.ChangesToPut(Spelled(plugin), document));

    public Answer<SourceChanges, SourceFailure> ChangesToRewrite(PluginAddress plugin, SourceDocument document) =>
        SourceFailure.Answer(() => Writes.ChangesToRewrite(Spelled(plugin), document));

    public Answer<SourceChanges, SourceFailure> ChangesToPutInWorldspace(PluginAddress plugin, SourceDocument cell, string worldspace) =>
        SourceFailure.Answer(() => Writes.ChangesToPutInWorldspace(Spelled(plugin), cell, worldspace));

    public Answer<SourceChanges, SourceFailure> ChangesToPutChild(
        PluginAddress plugin, RecordIdentity container, string slot, SourceDocument child) =>
        SourceFailure.Answer(() => Writes.ChangesToPutChild(Spelled(plugin), container, slot, child));

    public Answer<SourceChanges, SourceFailure> ChangesToRekey(PluginAddress plugin, RecordIdentity identity, string newFormKey) =>
        SourceFailure.Answer(() => Writes.ChangesToRekey(Spelled(plugin), identity, newFormKey));

    public Answer<SourceChanges, SourceFailure> ChangesToRemove(PluginAddress plugin, RecordIdentity identity) =>
        SourceFailure.Answer(() => Writes.ChangesToRemove(Spelled(plugin), identity));

    public SourceFailure? ReplaceSourceFrom(PluginAddress plugin, IReadOnlyList<TreeFile> tree, string binarySha256) =>
        SourceFailure.Answer(() =>
        {
            RefuseInASession();
            if (!TreeNameFor(plugin).Holds(out var folder, out var why) && why is SourceFailure.TwinFolders) throw SourceStopException.Of(why);
            var name = folder ?? plugin.Name;
            Writes.ReplaceSourceFrom(name, SourceRepositoryLayout.PristineFilesOf(name, tree), binarySha256);
        });

    public Answer<SourceChanges?, SourceFailure> ChangesToRenameSource(PluginAddress plugin, string newName) =>
        SourceFailure.Answer<SourceChanges?>(() =>
        {
            var name = Spelled(plugin).Name;
            var sources = Path.Combine(_modFolder, SourceRepositoryLayout.RootFolderName);
            return Files.EntriesUnder(sources).Any(entry => string.Equals(Path.GetFileName(entry), newName, StringComparison.OrdinalIgnoreCase)
                    && string.Equals(PathShape.DirectoryOf(entry), sources, SourceRepositoryLocator.PathComparison))
                ? null
                : Writes.ChangesToRenameSource(name, newName);
        });

    public string TreeNameOf(PluginAddress plugin) => Spelled(plugin).Name;

    public SourceFailure? MoveLastWrittenTo(string treeName, string newName)
    {
        RefuseInASession();
        return SourceFailure.Answer(() => Writes.MoveLastWritten(treeName, newName));
    }

    public Answer<bool, SourceFailure> WriteBinary(PluginAddress plugin, string binarySha256, Action write)
    {
        RefuseInASession();
        var name = Spelled(plugin).Name;
        return SourceFailure.Answer(() => _git.WriteBinary(name, binarySha256, write));
    }

    public Answer<IReadOnlyList<string>, SourceFailure> LastWrittenBinarySha256s(PluginAddress plugin)
    {
        var name = Spelled(plugin).Name;
        return SourceFailure.Answer(() => _git.LastWrittenBinarySha256s(name));
    }

    // A session writes nothing, and these verbs write the disk themselves.
    private void RefuseInASession()
    {
        if (Files is WriteSession) throw new InvalidOperationException("A session's repository answers changes and writes nothing to disk.");
    }

    // A plugin's tree is read and written as its folder spells it; with no single tree, as the load order names it.
    private PluginAddress Spelled(PluginAddress plugin) =>
        new(TreeNameFor(plugin).Holds(out var tree, out _) ? tree : plugin.Name, _modName);

    private Answer<string, SourceFailure> TreeNameFor(PluginAddress plugin)
    {
        if (!string.Equals(plugin.Origin, _modName, StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException(
                $"{plugin.Name} is provided by '{plugin.Origin}', and this repository holds '{_modName}'.", nameof(plugin));
        }
        return SourceRepositoryLayout.TreeNameIn(_modFolder, plugin.Name);
    }
}

/// <summary>One record as the Source tree holds it: its identity and its own text, byte for byte
/// (ADR-0005).</summary>
public sealed record SourceDocument(string FormKey, string RecordType, string? EditorId, string Body)
{
    public RecordIdentity Identity => new(FormKey, RecordType, EditorId);
}

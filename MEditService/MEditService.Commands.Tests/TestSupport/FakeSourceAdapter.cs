using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>Tracked mod folders holding their plugins' documents in memory. A verb the write path's document and
/// refusal tests do not reach throws.</summary>
internal sealed class FakeSourceAdapter : ISourceAdapter
{
    private readonly Dictionary<string, FakeMod> _mods = new(StringComparer.Ordinal);
    private readonly HashSet<string> _foreignRepositories = new(StringComparer.Ordinal);
    private readonly List<(string ModFolder, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> Plugins)> _tracked = [];

    internal int SessionsOpened { get; private set; }

    internal IReadOnlyList<(string ModFolder, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> Plugins)> TrackCalls => _tracked;

    internal FakeSourceAdapter HoldingAnotherRepository(string modFolder)
    {
        _foreignRepositories.Add(modFolder);
        return this;
    }

    internal FakeSourceAdapter Tracking(string modFolder, params SourceDocument[] documents)
    {
        _mods[modFolder] = new FakeMod(modFolder, documents.ToDictionary(document => document.FormKey, StringComparer.Ordinal));
        return this;
    }

    internal FakeSourceAdapter TrackingUnreadable(string modFolder, string reason)
    {
        _mods[modFolder] = new FakeMod(modFolder, [], new SourceFailure.Unreadable(reason));
        return this;
    }

    public bool IsTracked(RegisteredPlugin plugin) => plugin.Provider is PluginProvider.FromMod mod && IsTracked(mod.Folder);

    public bool IsTracked(string modFolder) => _mods.ContainsKey(modFolder);

    public bool SourceReads(RegisteredPlugin plugin) => IsTracked(plugin) && WhySourceDoesNotRead(plugin) is null;

    public SourceFailure? WhySourceDoesNotRead(RegisteredPlugin plugin) =>
        plugin.Provider is PluginProvider.FromMod mod && _mods.TryGetValue(mod.Folder, out var tracked) ? tracked.WhyUnreadable : null;

    public SourceFailure? WhyGitCannotRun() => null;

    public IWriteSession WriteSessionOver(PluginProvider.FromMod provider, GameRelease release, IReadOnlyList<DocumentChange> held)
    {
        SessionsOpened++;
        return new FakeWriteSession(new FakeRepository(_mods[provider.Folder]));
    }

    public ISourceRepositoryReads? Over(RegisteredPlugin plugin, GameRelease release) => throw Unreached();

    public ISourceRepositoryReads? TreeOf(RegisteredPlugin plugin, GameRelease release) => throw Unreached();

    public ISourceRepository? Open(PluginProvider.FromMod provider, GameRelease release) => throw Unreached();

    public ISourceRepository OverFolder(PluginProvider.FromMod provider, GameRelease release) => throw Unreached();

    public bool TreeHolds(RegisteredPlugin plugin, string path) => throw Unreached();

    public RecordOfFileAnswer RecordOfFile(LoadOrderSnapshot loadOrder, string path) => throw Unreached();

    public string FileNameOf(RecordIdentity identity) => throw Unreached();

    public bool HoldsAnotherRepository(string modFolder) => _foreignRepositories.Contains(modFolder);

    public string? InstanceRootNotFound(string? instanceRoot) => throw Unreached();

    public IReadOnlyList<(string Plugin, string Reason)> Track(
        string modFolder, IReadOnlyList<(IReadOnlyList<TreeFile> Tree, DecompiledPlugin Plugin)> plugins)
    {
        _tracked.Add((modFolder, plugins));
        return [];
    }

    public IReadOnlyList<TreeFile> ReadBackOf(string pluginFileName, IReadOnlyList<TreeFile> tree, GameRelease gameRelease) =>
        SourceRepository.ReadBackOf(pluginFileName, tree, gameRelease);

    private static NotSupportedException Unreached() => new("The fake Source adapter does not serve this verb.");

    private sealed record FakeMod(string Folder, Dictionary<string, SourceDocument> Documents, SourceFailure? WhyUnreadable = null);

    private sealed class FakeWriteSession(FakeRepository repository) : IWriteSession
    {
        private SourceFailure? _stopped;
        private bool _writing;

        public ISourceRepository Repository => repository;

        public SourceChanges Changes { get; private set; } = SourceChanges.None;

        public SourceChanges ChangesAddedSince(SourceChanges before) =>
            new(
                [.. Changes.Moves.Skip(before.Moves.Count)],
                [.. Changes.Deletions.Except(before.Deletions, StringComparer.Ordinal)],
                [.. Changes.Documents.Except(before.Documents)]);

        public SourceFailure? Atomically(Action write) =>
            Atomically(() =>
            {
                write();
                return SourceAnswer.Of(true);
            }).Holds(out _, out var failure)
                ? null
                : failure;

        public Answer<T, SourceFailure> Atomically<T>(Func<Answer<T, SourceFailure>> write)
        {
            var before = Changes;
            (_stopped, _writing) = (null, true);
            try
            {
                var answered = write();
                if (_stopped is null) return answered;
                Changes = before;
                return _stopped;
            }
            finally
            {
                _writing = false;
            }
        }

        public void Apply(Answer<SourceChanges, SourceFailure> changes)
        {
            if (!_writing) throw new InvalidOperationException("Changes are applied inside Atomically.");
            if (_stopped is not null) return;
            if (!changes.Holds(out var made, out var failure))
            {
                _stopped = failure;
                return;
            }

            var absolute = made.Under(repository);
            Changes = Changes with
            {
                Moves = [.. Changes.Moves, .. absolute.Moves],
                Deletions = [.. Changes.Deletions, .. absolute.Deletions],
                Documents = [.. Changes.Documents, .. absolute.Documents],
            };
        }
    }

    private sealed class FakeRepository(FakeMod mod) : ISourceRepository
    {
        public string ModFolder => mod.Folder;

        public Answer<SourceDocument?, SourceFailure> RecordByFormKey(PluginAddress plugin, string formKey) =>
            SourceAnswer.Of(mod.Documents.GetValueOrDefault(formKey));

        public Answer<SourceDocument?, SourceFailure> RecordOf(PluginAddress plugin, RecordIdentity identity) =>
            RecordByFormKey(plugin, identity.FormKey);

        public Answer<DocumentContainment?, SourceFailure> ContainerOf(PluginAddress plugin, RecordIdentity identity) =>
            SourceAnswer.Of<DocumentContainment?>(null);

        public Answer<string?, SourceFailure> RelativePathOf(PluginAddress plugin, RecordIdentity identity) =>
            SourceAnswer.Of<string?>(PathOf(plugin, identity.FormKey));

        public Answer<SourceChanges, SourceFailure> ChangesToRewrite(PluginAddress plugin, SourceDocument document) =>
            SourceAnswer.Of(new SourceChanges([], [], [new DocumentChange(PathOf(plugin, document.FormKey), document.Body)]));

        public string TreeNameOf(PluginAddress plugin) => plugin.Name;

        private static string PathOf(PluginAddress plugin, string formKey) => Path.Combine(plugin.Name, $"{formKey}.json");

        public RecordStamps StampsOf(PluginAddress plugin) => throw Unreached();

        public Answer<T, SourceFailure> ReadDocuments<T>(PluginAddress plugin, Func<IPluginDocuments, T> read) => throw Unreached();

        public Answer<IReadOnlyDictionary<string, RecordChange>, SourceFailure> ChangedSinceLastCommit(PluginAddress plugin) =>
            throw Unreached();

        public SourceFailure? WhyUnreadable(PluginAddress plugin, RecordIdentity identity, string body) => throw Unreached();

        public Answer<SourceDocument?, SourceFailure> RecordFromText(PluginAddress plugin, string formKey, string text) =>
            throw Unreached();

        public Answer<DocumentFile?, SourceFailure> DocumentOf(PluginAddress plugin, RecordIdentity identity) => throw Unreached();

        public Answer<string?, SourceFailure> FileNameOf(PluginAddress plugin, RecordIdentity identity) => throw Unreached();

        public Answer<string?, SourceFailure> WorldspaceOf(PluginAddress plugin, RecordIdentity identity) => throw Unreached();

        public Answer<CellStructure?, SourceFailure> CellStructureOf(PluginAddress plugin, RecordIdentity identity) =>
            throw Unreached();

        public Answer<SourceDocument?, SourceFailure> GetCellAt(PluginAddress plugin, string worldspace, int x, int y) =>
            throw Unreached();

        public Answer<IReadOnlySet<string>, SourceFailure> EditorIdsHeld(PluginAddress plugin) => throw Unreached();

        public Answer<IReadOnlySet<string>, SourceFailure> FormKeysUsed(PluginAddress plugin) => throw Unreached();

        public Answer<PluginSourceFiles, SourceFailure> TreeOf(PluginAddress plugin) => throw Unreached();

        public Answer<PluginDiagnosis, SourceFailure> InSourceNames(PluginAddress plugin, PluginDiagnosis diagnosis) =>
            throw Unreached();

        public Answer<IReadOnlyList<string>, SourceFailure> CollidingFormKeys(PluginAddress plugin, IEnumerable<FormKey> formKeys) =>
            throw Unreached();

        public Answer<SourceComparison, SourceFailure> Compare(PluginAddress plugin, IReadOnlyList<TreeFile> serialized) =>
            throw Unreached();

        public Answer<SourceChanges, SourceFailure> ChangesToPut(PluginAddress plugin, SourceDocument document) => throw Unreached();

        public Answer<SourceChanges, SourceFailure> ChangesToPutInWorldspace(PluginAddress plugin, SourceDocument cell, string worldspace) =>
            throw Unreached();

        public Answer<SourceChanges, SourceFailure> ChangesToPutChild(
            PluginAddress plugin, RecordIdentity container, string slot, SourceDocument child) => throw Unreached();

        public Answer<SourceChanges, SourceFailure> ChangesToRekey(PluginAddress plugin, RecordIdentity identity, string newFormKey) =>
            throw Unreached();

        public Answer<SourceChanges, SourceFailure> ChangesToRemove(PluginAddress plugin, RecordIdentity identity) => throw Unreached();

        public Answer<SourceChanges?, SourceFailure> ChangesToRenameSource(PluginAddress plugin, string newName) => throw Unreached();

        public SourceFailure? ReplaceSourceFrom(PluginAddress plugin, IReadOnlyList<TreeFile> tree, string binarySha256) =>
            throw Unreached();

        public SourceFailure? MoveLastWrittenTo(string treeName, string newName) => throw Unreached();

        public Answer<bool, SourceFailure> WriteBinary(PluginAddress plugin, string binarySha256, Action write) => throw Unreached();

        public Answer<IReadOnlyList<string>, SourceFailure> LastWrittenBinarySha256s(PluginAddress plugin) => throw Unreached();
    }
}

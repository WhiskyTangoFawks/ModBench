using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class WriteNamingItsFilesTests : IDisposable
{
    private const string Overrides = "Overrides.esp";
    private const string NewFormKey = $"000F20:{ContainerMod.PluginName}";

    private static readonly string[] Relations =
    [
        "SELECT * FROM mirror.records", "SELECT * FROM mirror.form_references", "SELECT * FROM mirror.holdings",
        "SELECT * FROM mirror.cell_location", "SELECT * FROM winners",
    ];

    private readonly ScatteredFixtureData _fixture;
    private readonly ContainerModPlugin.Keys _keys;
    private readonly FormKey _npc;
    private readonly ScratchDirectory _instances = new("medit-write-naming-its-files-");
    private readonly CountingTreeSource _source = new(TestAdapters.Source());
    private readonly LoadOrderHolder _holder = new();
    private readonly OpenedIndex _index;
    private Action _onWritten = () => { };

    public WriteNamingItsFilesTests()
    {
        var (keys, npc) = (default(ContainerModPlugin.Keys), default(FormKey));
        _fixture = new PluginFixtureBuilder("write-naming-its-files")
            .WithPlugin(ContainerMod.PluginName, mod =>
            {
                keys = ContainerModPlugin.AddTo(mod);
                npc = mod.Npcs.AddNew(ContainerMod.NpcEditorId).FormKey;
            }, origin: ContainerMod.Origin)
            .WithPlugin(Overrides, (mod, _) => mod.Npcs.Add(new Npc(npc, Fallout4Release.Fallout4) { EditorID = "OverriddenNpc" }), origin: "OverridesMod")
            .BuildScattered()
            .CompiledPlugin();
        (_keys, _npc) = (keys, npc);
        _holder.Written += (_, _) => _onWritten();
        _index = Indexes.Open(_holder, source: _source);
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, Instance("written"));
    }

    public void Dispose()
    {
        _index.Dispose();
        _instances.Dispose();
        _fixture.Dispose();
    }

    private LoadOrderEntry Container => _fixture.Plugins.Single(plugin => plugin.Name == ContainerMod.PluginName);

    private LoadOrderEntry Overriding => _fixture.Plugins.Single(plugin => plugin.Name == Overrides);

    private string Instance(string name) => Directory.CreateDirectory(Path.Combine(_instances, name)).FullName;

    private static ISourceRepository RepositoryOf(LoadOrderEntry entry) => SourceMods.RepositoryOf(entry);

    private RecordDetail Record(FormKey record, LoadOrderEntry? entry = null) => _index.DocumentOf(record.ToString(), (entry ?? Container).Key);

    private RecordIdentity Identity(FormKey record, LoadOrderEntry? entry = null)
    {
        var held = Record(record, entry);
        return new RecordIdentity(held.FormKey, held.RecordType, held.EditorId);
    }

    private SourceDocument Renamed(FormKey record, string editorId)
    {
        var held = Record(record);
        return new SourceDocument(
            held.FormKey, held.RecordType, editorId,
            Container.SourceTextOf(held).Replace($"\"{held.EditorId}\"", $"\"{editorId}\"", StringComparison.Ordinal));
    }

    private SourceDocument Copied(FormKey record, string formKey, string? editorId = null, Action<JsonObject>? shape = null)
    {
        var held = Record(record);
        var text = Container.SourceTextOf(held).Replace(held.FormKey, formKey, StringComparison.Ordinal)
            .Replace($"\"{held.EditorId}\"", $"\"{editorId ?? held.EditorId}\"", StringComparison.Ordinal);
        var document = JsonNode.Parse(text).Require().AsObject();
        shape?.Invoke(document);
        return new SourceDocument(formKey, held.RecordType, editorId ?? held.EditorId, document.ToJsonString());
    }

    private static (LoadOrderEntry Entry, SourceChanges Made) Saved(LoadOrderEntry entry, Answer<SourceChanges, SourceFailure> changes)
    {
        var made = changes.Value().Under(RepositoryOf(entry).SourceFolder);
        EditSaving.Save(made.Moves.Select(move => (move.From, move.To)), made.Deletions, made.Documents.Select(document => (document.Path, document.Text)));
        return (entry, made);
    }

    private static PluginChange Named((LoadOrderEntry Entry, SourceChanges Made) saved) =>
        new(saved.Entry.Key, [
            .. saved.Made.Moves.SelectMany(move => new[] { move.From, move.To }), .. saved.Made.Deletions,
            .. saved.Made.Documents.Select(document => document.Path)]);

    private void Written((LoadOrderEntry Entry, SourceChanges Made) saved)
    {
        _holder.SourceWritten([Named(saved)]);
        _ = _index.ListedIn(saved.Entry.Key);
        _index.Settled();
    }

    private static string RowsIn(string instance) =>
        string.Join("\n", Relations.SelectMany(relation => IndexFiles.Rows(instance, relation).Select(row => $"{relation}: {string.Join(" | ", row)}")));

    private void AssertTheRowsAFreshReadHolds()
    {
        var fresh = Instance("fresh");
        using (Indexes.Reconciled(_fixture.DataFolder, _fixture.Plugins, fresh))
            Assert.Equal(RowsIn(fresh), RowsIn(Instance("written")));
    }

    private static readonly Dictionary<string, Func<WriteNamingItsFilesTests, (LoadOrderEntry, SourceChanges)>> Writes = new()
    {
        ["a record created"] = test => Saved(test.Container, RepositoryOf(test.Container).ChangesToPut(test.Container.Key, test.Copied(test._npc, NewFormKey, "CreatedNpc"))),
        ["a record deleted"] = test => Saved(test.Container, RepositoryOf(test.Container).ChangesToRemove(test.Container.Key, test.Identity(test._npc))),
        ["a record renamed"] = test => Saved(test.Container, RepositoryOf(test.Container).ChangesToPut(test.Container.Key, test.Renamed(test._npc, "RenamedNpc"))),
        ["an interior cell created"] = test => Saved(test.Container, RepositoryOf(test.Container).ChangesToPut(test.Container.Key, test.Copied(test._keys.Cell, NewFormKey, "CreatedCell"))),
        ["a cell and its references deleted"] = test => Saved(test.Container, RepositoryOf(test.Container).ChangesToRemove(test.Container.Key, test.Identity(test._keys.EmbedCell))),
        ["a reference put in a cell"] = test => Saved(test.Container, RepositoryOf(test.Container).ChangesToPutChild(
            test.Container.Key, test.Identity(test._keys.EmbedCell), "Temporary", test.Copied(test._keys.TemporaryRef, NewFormKey, "PutRef"))),
        ["a reference moved between cells"] = test => Saved(test.Container, SourceAnswer.Of(
            RepositoryOf(test.Container).ChangesToRemove(test.Container.Key, test.Identity(test._keys.TemporaryRef)).Value()
                .Then(RepositoryOf(test.Container).ChangesToPutChild(
                    test.Container.Key, test.Identity(test._keys.Cell), "Temporary", test.Copied(test._keys.TemporaryRef, test._keys.TemporaryRef.ToString())).Value()))),
        ["an exterior cell created"] = test => Saved(test.Container, RepositoryOf(test.Container).ChangesToPutInWorldspace(
            test.Container.Key, test.Copied(test._keys.Cell, NewFormKey, "ExteriorCell", cell => cell["Grid"] = new JsonObject { ["Point"] = "3, 4" }),
            test._keys.Worldspace.ToString())),
        ["an override deleted, so the master's record wins"] = test => Saved(test.Overriding, RepositoryOf(test.Overriding).ChangesToRemove(
            test.Overriding.Key, test.Identity(test._npc, test.Overriding))),
        ["a record copied as an override"] = test => Saved(test.Overriding, RepositoryOf(test.Overriding).ChangesToPut(
            test.Overriding.Key, test.Copied(test._keys.Cell, test._keys.Cell.ToString()))),
    };

    public static TheoryData<string> WriteKinds() => [.. Writes.Keys];

    private static readonly string[] MakingACellsBlock = ["an interior cell created", "an exterior cell created", "a record copied as an override"];

    public static TheoryData<string> WritesReadAlone() => [.. Writes.Keys.Except(MakingACellsBlock)];

    public static TheoryData<string> WritesMakingACellsBlock() => [.. MakingACellsBlock];

    [Theory]
    [MemberData(nameof(WriteKinds))]
    public void AWriteNamingItsFiles_LeavesTheRowsAFreshReadOfTheTreeHolds(string write)
    {
        Written(Writes[write](this));

        AssertTheRowsAFreshReadHolds();
    }

    [Theory]
    [MemberData(nameof(WritesReadAlone))]
    public void AWriteNamingItsFiles_ReadsThemAlone_AndNoWholeTree(string write)
    {
        var saved = Writes[write](this);
        var (named, wholeReads, wholeStatuses) = (_source.NamedReads, _source.WholeTreeReads, _source.GitStatusAsked);

        Written(saved);

        Assert.Equal((named + 1, wholeReads, wholeStatuses), (_source.NamedReads, _source.WholeTreeReads, _source.GitStatusAsked));
    }

    [Theory]
    [MemberData(nameof(WritesMakingACellsBlock))]
    public void AWriteThatMakesACellsBlock_NamesItsGroupDocument_SoThePluginIsReadWhole(string write)
    {
        var saved = Writes[write](this);
        var wholeReads = _source.WholeTreeReads;

        Written(saved);

        Assert.True(_source.WholeTreeReads > wholeReads);
    }

    [Fact]
    public void AChangeSignalledNamingAGroupDocumentBrokenByHand_ShowsItsRefusal()
    {
        var block = Directory.GetDirectories(Path.Combine(Container.ModFolderOf(), PluginSourceRoot.For(ContainerMod.PluginName), "Cells")).First();
        var group = Path.Combine(block, "GroupRecordData.json");
        File.WriteAllText(group, "{\"BlockNumber\": \"text\"}");

        _index.SignalChange([new PluginChange(Container.Key, [group])]);
        Waits.Reached(() => !_index.Status.Validating, "the signal's read");

        Assert.Contains(
            Path.GetRelativePath(Container.ModFolderOf(), group),
            _index.Queries.GetProblems().Value().Single(problems => PluginAddress.Comparer.Equals(problems.Plugin, Container.Key)).Problems.Select(problem => problem.SourceRelativePath));
    }

    [Fact]
    public void AWriteToARecordAnEarlierWriteMoved_LeavesTheRowsAFreshReadOfTheTreeHolds()
    {
        Written(Saved(Container, RepositoryOf(Container).ChangesToPut(Container.Key, Renamed(_npc, "RenamedNpc"))));

        Written(Saved(Container, RepositoryOf(Container).ChangesToPut(Container.Key, Renamed(_npc, "RenamedAgain"))));

        AssertTheRowsAFreshReadHolds();
    }

    [Fact]
    public void AnotherFilesHandEdit_IsLeftByAWriteNamingItsFiles_AndFoundByTheNextCheck()
    {
        Container.HandEdit(Record(_keys.Cell), $"\"{ContainerModPlugin.CellEditorId}\"", "\"EditedByHand\"");
        Written(Saved(Container, RepositoryOf(Container).ChangesToPut(Container.Key, Renamed(_npc, "RenamedNpc"))));
        var afterTheWrite = Record(_keys.Cell).EditorId;

        _index.NextCheckUntil(() => Record(_keys.Cell).EditorId == "EditedByHand", "the hand edit read");

        Assert.Equal((ContainerModPlugin.CellEditorId, "RenamedNpc"), (afterTheWrite, Record(_npc).EditorId));
    }

    [Fact]
    public void ARecordAWriteCreated_IsAdded()
    {
        Written(Writes["a record created"](this));

        Assert.Equal(WorkingTreeState.Added, _index.RowOf(NewFormKey, Container.Key)?.WorkingTreeState);
    }

    [Fact]
    public void AWriteWhoseNamedReadThrows_IsReadWhole()
    {
        _source.FailNextNamedRead();
        var wholeReads = _source.WholeTreeReads;

        Written(Saved(Container, RepositoryOf(Container).ChangesToPut(Container.Key, Renamed(_npc, "RenamedNpc"))));

        Assert.Equal("RenamedNpc", Record(_npc).EditorId);
        Assert.True(_source.WholeTreeReads > wholeReads);
    }

    [Fact]
    public void AWriteNamingTheHeader_ReadsThePluginWhole()
    {
        var header = Directory.GetFiles(Path.Combine(Container.ModFolderOf(), PluginSourceRoot.For(ContainerMod.PluginName)), "*.json", SearchOption.TopDirectoryOnly).Single();
        var wholeReads = _source.WholeTreeReads;

        _holder.SourceWritten([new PluginChange(Container.Key, [header])]);
        _ = _index.ListedIn(Container.Key);

        Assert.True(_source.WholeTreeReads > wholeReads);
    }

    [Fact]
    public async Task AWriteCountedWhileATurnReadsAnotherWritesFiles_IsReadBeforeAReadAfterItAnswers()
    {
        var renamedNpc = Saved(Container, RepositoryOf(Container).ChangesToPut(Container.Key, Renamed(_npc, "RenamedNpc")));
        var renamedCell = Saved(Container, RepositoryOf(Container).ChangesToPut(Container.Key, Renamed(_keys.Cell, "RenamedCell")));
        using var paused = new FirstRaisePaused();
        _onWritten = paused.Raised;
        var first = Task.Run(() => _holder.SourceWritten([Named(renamedNpc)]));
        paused.Counted.Wait();
        var second = Task.Run(() => _holder.SourceWritten([Named(renamedCell)]));

        var npcRead = Record(_npc).EditorId;

        paused.Released.Set();
        await Task.WhenAll(first, second);
        Assert.Equal("RenamedNpc", npcRead);
    }

    [Fact]
    public async Task AWriteCountedAsATurnBegins_IsNotVouchedForByThatTurnsNamedRead()
    {
        var deleteOverride = RepositoryOf(Overriding).ChangesToRemove(Overriding.Key, Identity(_npc, Overriding));
        var createNpc = RepositoryOf(Container).ChangesToPut(Container.Key, Copied(_npc, NewFormKey, "CreatedNpc"));
        var renameNpc = RepositoryOf(Container).ChangesToPut(Container.Key, Renamed(_npc, "RenamedNpc"));
        using var held = new FirstAndThirdNamedReadsHeld();
        _source.BeforeEachNamedRead = held.Before;
        _holder.SourceWritten([Named(Saved(Overriding, deleteOverride))]);
        held.FirstReached.Wait();
        _holder.SourceWritten([Named(Saved(Container, createNpc))]);
        var renamedNpc = Saved(Container, renameNpc);
        using var paused = new FirstRaisePaused();
        _onWritten = paused.Raised;
        var npcWritten = Task.Run(() => _holder.SourceWritten([Named(renamedNpc)]));
        paused.Counted.Wait();
        held.First.Set();
        Waits.Reached(() => _source.NamedReads == 2 && !_index.Status.Validating, "the turn reading the created record");

        var npcRead = _index.RowOf(_npc.ToString(), Container.Key)?.EditorId;

        held.Third.Set();
        await npcWritten;
        Assert.Equal("RenamedNpc", npcRead);
    }

    private sealed class FirstAndThirdNamedReadsHeld : IDisposable
    {
        private static readonly TimeSpan AtMost = TimeSpan.FromSeconds(5);
        private int _reads = -1;

        public ManualResetEventSlim FirstReached { get; } = new();

        public ManualResetEventSlim First { get; } = new();

        public ManualResetEventSlim Third { get; } = new();

        public void Before()
        {
            var read = Interlocked.Increment(ref _reads);
            if (read == 0)
            {
                FirstReached.Set();
                First.Wait(AtMost);
            }
            if (read == 2) Third.Wait(AtMost);
        }

        public void Dispose()
        {
            FirstReached.Dispose();
            First.Dispose();
            Third.Dispose();
        }
    }

    private sealed class FirstRaisePaused : IDisposable
    {
        private static readonly TimeSpan AtMost = TimeSpan.FromSeconds(2);
        private int _raised;

        public ManualResetEventSlim Counted { get; } = new();

        public ManualResetEventSlim Released { get; } = new();

        public void Raised()
        {
            if (Interlocked.Exchange(ref _raised, 1) == 1) return;
            Counted.Set();
            Released.Wait(AtMost);
        }

        public void Dispose()
        {
            Counted.Dispose();
            Released.Dispose();
        }
    }

    [Fact]
    public void AChangeSignalledNamingFilesTheIndexAlreadyRead_ReadsThemAndNothingMore()
    {
        var saved = Saved(Container, RepositoryOf(Container).ChangesToPut(Container.Key, Renamed(_npc, "RenamedNpc")));
        Written(saved);
        var (sequence, named, wholeReads, statuses) = (_index.Sequence, _source.NamedReads, _source.WholeTreeReads, _source.NamedGitStatusAsked);

        _index.SignalChange([Named(saved)]);
        Waits.Reached(() => !_index.Status.Validating, "the signal's read");

        Assert.Equal((sequence, named + 1, wholeReads, statuses), (_index.Sequence, _source.NamedReads, _source.WholeTreeReads, _source.NamedGitStatusAsked));
    }

    [Fact]
    public void AChangeSignalledNamingAFileEditedByHand_ReadsItAlone()
    {
        var cell = Container.SourceFileOf(Record(_keys.Cell));
        Container.HandEdit(Record(_keys.Cell), $"\"{ContainerModPlugin.CellEditorId}\"", "\"EditedByHand\"");
        var wholeReads = _source.WholeTreeReads;

        _index.SignalChange([new PluginChange(Container.Key, [cell])]);
        Waits.Reached(() => Record(_keys.Cell).EditorId == "EditedByHand", "the hand edit read");

        Assert.Equal(wholeReads, _source.WholeTreeReads);
    }
}

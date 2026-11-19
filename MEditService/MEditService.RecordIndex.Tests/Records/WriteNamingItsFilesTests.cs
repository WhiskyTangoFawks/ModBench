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
        "SELECT * EXCLUDE (copy_id) FROM mirror.records", "SELECT * FROM mirror.form_references", "SELECT * FROM mirror.holdings", "SELECT * FROM mirror.document_names",
        "SELECT * FROM mirror.cell_location", "SELECT * FROM winners",
    ];

    private readonly ScatteredFixtureData _fixture;
    private readonly ContainerModPlugin.Keys _keys;
    private readonly FormKey _npc;
    private readonly FormKey _quest;
    private readonly FormKey _topic;
    private readonly ScratchDirectory _instances = new("medit-write-naming-its-files-");
    private readonly CountingTreeSource _source = new(TestAdapters.Source());
    private readonly LoadOrderHolder _holder = new();
    private readonly OpenedIndex _index;

    public WriteNamingItsFilesTests()
    {
        var (keys, npc, quest, topic) = (default(ContainerModPlugin.Keys), default(FormKey), default(FormKey), default(FormKey));
        _fixture = new PluginFixtureBuilder("write-naming-its-files")
            .WithPlugin(ContainerMod.PluginName, mod =>
            {
                keys = ContainerModPlugin.AddTo(mod);
                npc = mod.Npcs.AddNew(ContainerMod.NpcEditorId).FormKey;
                var owner = mod.Quests.AddNew("FixtureQuest");
                var held = new DialogTopic(mod) { EditorID = "FixtureTopic" };
                owner.DialogTopics.Add(held);
                (quest, topic) = (owner.FormKey, held.FormKey);
            }, origin: ContainerMod.Origin)
            .WithPlugin(Overrides, (mod, _) => mod.Npcs.Add(new Npc(npc, Fallout4Release.Fallout4) { EditorID = "OverriddenNpc" }), origin: "OverridesMod")
            .BuildScattered()
            .CompiledPlugin();
        (_keys, _npc, _quest, _topic) = (keys, npc, quest, topic);
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

    private static HandedPlugin Handed((LoadOrderEntry Entry, SourceChanges Made) saved) =>
        new(saved.Entry.Key, Named(saved).Files.Require(), [.. saved.Made.Documents.Select(document =>
            new WrittenDocument(document.Path, document.Text, FileStamp.Of(document.Path).Require()))]);

    private static HandedPlugin HandedRenamedAgain(HandedPlugin handed, string editorId) =>
        handed with { Documents = [.. handed.Documents.Select(document => document with { Text = document.Text.Replace("RenamedNpc", editorId, StringComparison.Ordinal) })] };

    private Task<string?> Hold(params HandedPlugin[] written) => _index.Queries.Hold(written, CancellationToken.None);

    private (LoadOrderEntry Entry, SourceChanges Made) NpcRenamed() =>
        Saved(Container, RepositoryOf(Container).ChangesToPut(Container.Key, Renamed(_npc, "RenamedNpc")));

    private void Written((LoadOrderEntry Entry, SourceChanges Made) saved)
    {
        Assert.Null(Hold(Handed(saved)).GetAwaiter().GetResult());
        _index.Settled();
    }

    private void Watched((LoadOrderEntry Entry, SourceChanges Made) saved)
    {
        _index.SignalChange([Named(saved)]);
        Waits.Reached(() => !_index.Status.Validating, "the watch's read");
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
        ["a topic put in a quest"] = test => Saved(test.Container, RepositoryOf(test.Container).ChangesToPutChild(
            test.Container.Key, test.Identity(test._quest), "DialogTopics", test.Copied(test._topic, NewFormKey, "PutTopic"))),
        ["a topic deleted"] = test => Saved(test.Container, RepositoryOf(test.Container).ChangesToRemove(test.Container.Key, test.Identity(test._topic))),
        ["an exterior cell created"] = test => Saved(test.Container, RepositoryOf(test.Container).ChangesToPutInWorldspace(
            test.Container.Key, test.Copied(test._keys.Cell, NewFormKey, "ExteriorCell", cell => cell["Grid"] = new JsonObject { ["Point"] = "3, 4" }),
            test._keys.Worldspace.ToString())),
        ["an override deleted, so the master's record wins"] = test => Saved(test.Overriding, RepositoryOf(test.Overriding).ChangesToRemove(
            test.Overriding.Key, test.Identity(test._npc, test.Overriding))),
        ["a record copied as an override"] = test => Saved(test.Overriding, RepositoryOf(test.Overriding).ChangesToPut(
            test.Overriding.Key, test.Copied(test._keys.Cell, test._keys.Cell.ToString()))),
    };

    private static readonly Dictionary<string, Action<WriteNamingItsFilesTests, (LoadOrderEntry, SourceChanges)>> Roads = new()
    {
        ["handed by its writer"] = (test, saved) => test.Written(saved),
        ["named by the watch"] = (test, saved) => test.Watched(saved),
    };

    public static TheoryData<string, string> WriteKindsByRoad()
    {
        TheoryData<string, string> table = [];
        foreach (var write in Writes.Keys)
        {
            foreach (var road in Roads.Keys) table.Add(write, road);
        }
        return table;
    }

    private static readonly string[] MakingACellsBlock = ["an interior cell created", "an exterior cell created", "a record copied as an override"];

    public static TheoryData<string> WritesReadAlone() => [.. Writes.Keys.Except(MakingACellsBlock)];

    public static TheoryData<string> WritesMakingACellsBlock() => [.. MakingACellsBlock];

    [Theory]
    [MemberData(nameof(WriteKindsByRoad))]
    public void AWrite_LeavesTheRowsAFreshReadOfTheTreeHolds(string write, string road)
    {
        Roads[road](this, Writes[write](this));

        AssertTheRowsAFreshReadHolds();
    }

    [Fact]
    public async Task TheRowsHoldTheHandedDocument_NotAReadOfItsFile()
    {
        await Hold(HandedRenamedAgain(Handed(NpcRenamed()), "HandedNpc"));

        Assert.Equal("HandedNpc", Record(_npc).EditorId);
    }

    [Fact]
    public async Task TheWatchNamingAFileWhoseHandedDocumentsStampHasNotSettled_ReadsItAgain()
    {
        var saved = NpcRenamed();
        await Hold(HandedRenamedAgain(Handed(saved), "HandedNpc"));

        _index.SignalChange([Named(saved)]);
        Waits.Reached(() => !_index.Status.Validating, "the watch's read");

        Assert.Equal("RenamedNpc", Record(_npc).EditorId);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AFileTheWatchNamesInTheTurnThatTakesItsHandedDocument_IsReadFromTheFile(bool watchFirst)
    {
        using var held = new FirstNamedReadHeld();
        _source.BeforeEachNamedRead = held.Before;
        _index.SignalChange([Named(Saved(Overriding, RepositoryOf(Overriding).ChangesToRemove(Overriding.Key, Identity(_npc, Overriding))))]);
        held.Reached.Wait();
        var saved = NpcRenamed();

        if (watchFirst) _index.SignalChange([Named(saved)]);
        var hand = Hold(HandedRenamedAgain(Handed(saved), "HandedNpc"));
        if (!watchFirst) _index.SignalChange([Named(saved)]);
        held.Release.Set();
        await hand;

        Assert.Equal("RenamedNpc", Record(_npc).EditorId);
    }

    private sealed class FirstNamedReadHeld : IDisposable
    {
        private int _reads;

        public ManualResetEventSlim Reached { get; } = new();

        public ManualResetEventSlim Release { get; } = new();

        public void Before()
        {
            if (Interlocked.Increment(ref _reads) != 1) return;
            Reached.Set();
            Release.Wait();
        }

        public void Dispose()
        {
            Release.Set();
            Reached.Dispose();
        }
    }

    [Fact]
    public async Task AHand_IsAnsweredOnlyOnceTheRecordIndexHoldsIt()
    {
        using var reading = new ManualResetEventSlim();
        _source.BeforeEachNamedRead = reading.Wait;

        var hand = Hold(Handed(NpcRenamed()));

        Assert.False(hand.IsCompleted);
        reading.Set();
        Assert.Null(await hand);
        Assert.Equal("RenamedNpc", Record(_npc).EditorId);
    }

    [Fact]
    public async Task AHandForAPluginTheLoadOrderDoesNotHold_IsAnsweredWithWhy()
    {
        var unread = await Hold(new HandedPlugin(new PluginAddress("Absent.esp", "AbsentMod"), [], []));

        Assert.Contains("does not hold Absent.esp", unread, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AHandWhosePluginCannotBeRead_IsAnsweredWithWhy()
    {
        var npc = Container.SourceFileOf(Record(_npc));
        File.WriteAllText(npc, "{ not a document");

        var unread = await Hold(new HandedPlugin(Container.Key, [npc], [new WrittenDocument(npc, "{ not a document", FileStamp.Of(npc).Require())]));

        Assert.Contains(ContainerMod.PluginName, unread, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AHandNamingNoPlugin_IsAnsweredOnceACheckOfTheDiskHasReadIt()
    {
        using var reading = new ManualResetEventSlim();
        Container.HandEdit(Record(_keys.Cell), $"\"{ContainerModPlugin.CellEditorId}\"", "\"EditedByHand\"");
        _source.BeforeNextGitStatus = reading.Wait;

        var hand = _index.Queries.Hold(null, CancellationToken.None);

        Assert.False(hand.IsCompleted);
        reading.Set();
        Assert.Null(await hand);
        Assert.Equal("EditedByHand", Record(_keys.Cell).EditorId);
    }

    [Fact]
    public async Task AHandTheRecordIndexTakesAfterItCloses_IsAnsweredThatItClosed()
    {
        var (queries, handed) = (_index.Queries, Handed(NpcRenamed()));
        _index.Dispose();

        Assert.Contains("closed", await queries.Hold([handed], CancellationToken.None), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AHandBeforeAnyLoadOrder_IsAnsweredThatItWasNotRead()
    {
        using var bare = Indexes.Open(new LoadOrderHolder());

        Assert.Contains("stopped", await bare.Queries.Hold([Handed(NpcRenamed())], CancellationToken.None), StringComparison.Ordinal);
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
    public async Task AWriteNamingTheHeader_ReadsThePluginWhole()
    {
        var header = Directory.GetFiles(Path.Combine(Container.ModFolderOf(), PluginSourceRoot.For(ContainerMod.PluginName)), "*.json", SearchOption.TopDirectoryOnly).Single();
        var wholeReads = _source.WholeTreeReads;

        Assert.Null(await Hold(new HandedPlugin(Container.Key, [header], [])));

        Assert.True(_source.WholeTreeReads > wholeReads);
    }

    [Fact]
    public async Task AHandTakenWhileATurnReadsAnotherWritesFiles_IsAnsweredOnlyOnceItsOwnFilesAreRead()
    {
        var deleteOverride = Saved(Overriding, RepositoryOf(Overriding).ChangesToRemove(Overriding.Key, Identity(_npc, Overriding)));
        var renamedNpc = NpcRenamed();
        using var held = new FirstTwoNamedReadsHeld();
        _source.BeforeEachNamedRead = held.Before;
        _index.SignalChange([Named(deleteOverride)]);
        held.FirstReached.Wait();
        var hand = Hold(Handed(renamedNpc));
        held.First.Set();
        held.SecondReached.Wait();

        Assert.False(hand.IsCompleted);
        held.Second.Set();
        Assert.Null(await hand);
        Assert.Equal("RenamedNpc", Record(_npc).EditorId);
    }

    private sealed class FirstTwoNamedReadsHeld : IDisposable
    {
        private readonly CancellationTokenSource _abandoned = new();
        private int _reads = -1;

        public ManualResetEventSlim FirstReached { get; } = new();

        public ManualResetEventSlim First { get; } = new();

        public ManualResetEventSlim SecondReached { get; } = new();

        public ManualResetEventSlim Second { get; } = new();

        public void Before()
        {
            var read = Interlocked.Increment(ref _reads);
            if (read == 0)
            {
                FirstReached.Set();
                First.Wait(_abandoned.Token);
            }
            if (read == 1)
            {
                SecondReached.Set();
                Second.Wait(_abandoned.Token);
            }
        }

        public void Dispose()
        {
            _abandoned.Cancel();
            _abandoned.Dispose();
            FirstReached.Dispose();
            First.Dispose();
            SecondReached.Dispose();
            Second.Dispose();
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

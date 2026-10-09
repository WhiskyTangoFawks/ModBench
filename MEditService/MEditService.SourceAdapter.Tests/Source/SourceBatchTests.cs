using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceBatchTests : IDisposable
{
    private const string PluginName = "Batch.esp";
    private static readonly PluginAddress Plugin = new(PluginName, TestMod.Name);
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private readonly ScratchDirectory _modFolder = new("medit-batch-");
    private readonly Fallout4Mod _mod = new(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
    private readonly Quest _quest;
    private readonly DialogTopic _topic;
    private readonly DialogResponses _response;
    private readonly DialogResponses _response2;
    private readonly Cell _cell;
    private readonly Worldspace _worldspace;
    private readonly Cell _exteriorCell;
    private readonly byte[] _header;

    public SourceBatchTests()
    {
        _response = new DialogResponses(_mod) { EditorID = "Response" };
        _response2 = new DialogResponses(_mod) { EditorID = "Response2" };
        _topic = new DialogTopic(_mod) { EditorID = "Topic" };
        _topic.Responses.Add(_response);
        _topic.Responses.Add(_response2);
        _quest = new Quest(_mod) { EditorID = "Quest" };
        _quest.DialogTopics.Add(_topic);
        _cell = new Cell(_mod) { EditorID = "Cell" };
        _cell.Temporary.Add(new PlacedObject(_mod) { EditorID = "Ref" });
        _worldspace = new Worldspace(_mod) { EditorID = "World" };
        _exteriorCell = new Cell(_mod) { EditorID = "Exterior" };
        _header = HeaderDocument.Write(_mod);

        PluginBaselines.Track(_modFolder, TheTree());
    }

    private TreeFile[] TheTree() =>
    [
        new(QuestPath, Serialize(_quest)),
        new(CellPath, Serialize(_cell)),
        new(WorldspacePath, Serialize(_worldspace)),
        new(ExteriorCellPath, Serialize(_exteriorCell)),
        new(PluginSourceRoot.HeaderDocument(PluginName), _header),
    ];

    private string WorldspaceDirectory =>
        Path.Combine(PluginSourceRoot.For(PluginName), "Worldspaces", $"World - {_worldspace.FormKey.ID:X6}_{PluginName}");

    private string WorldspacePath => PluginSourceRoot.ContainerDocument(WorldspaceDirectory);

    private string ExteriorCellPath =>
        PluginSourceRoot.ContainerDocument(Path.Combine(
            WorldspaceDirectory, "0, 0", "0, 0", $"Exterior - {_exteriorCell.FormKey.ID:X6}_{PluginName}"));

    private string CellPath =>
        PluginSourceRoot.ContainerDocument(Path.Combine(
            PluginSourceRoot.For(PluginName), "Cells", "0", "0", $"Cell - {_cell.FormKey.ID:X6}_{PluginName}"));

    public void Dispose() => _modFolder.Dispose();

    private string QuestPath =>
        Path.Combine(PluginSourceRoot.For(PluginName), "Quests", $"Quest - {_quest.FormKey.ID:X6}_{PluginName}.json");

    private string FullPath(string relativePath) => Path.Combine(_modFolder, relativePath);

    private static byte[] Serialize(IMajorRecordGetter record) =>
        Encoding.UTF8.GetBytes(RecordTextCodec.SerializeToText(record, Release));

    private SourceRepository Repository => SourceRepository.Over(TestMod.In(_modFolder), Release);

    private static RecordIdentity Identity(IMajorRecordGetter record, string recordType) =>
        new(record.FormKey.ToString(), recordType, record.EditorID);

    private string UnsavedQuest() =>
        File.ReadAllText(FullPath(QuestPath)).Replace("\"Response2\"", "\"UnsavedName\"", StringComparison.Ordinal);

    [Fact]
    public void ARead_TakesTheUnsavedTextOfADocument_InPlaceOfItsFile()
    {
        var batch = SourceBatch.Over(Repository, [new DocumentChange(FullPath(QuestPath), UnsavedQuest())]);

        var response = batch.Repository.RecordOf(Plugin, Identity(_response2, "info")).Value().Require();

        Assert.Contains("\"UnsavedName\"", response.Body, StringComparison.Ordinal);
    }

    private static SourceFailure? Write(SourceBatch batch, Func<SourceRepository, SourceAnswer<SourceChanges>> changes) =>
        SourceTransaction.Atomically(batch.Repository, transaction => transaction.Apply(changes(batch.Repository)));

    [Fact]
    public void TwoRemovalsFromOneDocument_AnswerItsTextWithoutEither_AndWriteNothing()
    {
        var before = TreeSnapshot.Of(_modFolder);
        var batch = SourceBatch.Over(Repository, []);

        Assert.Null(Write(batch, repository => repository.ChangesToRemove(Plugin, Identity(_response, "info"))));
        Assert.Null(Write(batch, repository => repository.ChangesToRemove(Plugin, Identity(_response2, "info"))));

        var document = Assert.Single(batch.Changes.Documents);
        Assert.Equal(FullPath(QuestPath), document.Path);
        Assert.DoesNotContain("\"Response\"", document.Text, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Response2\"", document.Text, StringComparison.Ordinal);
        Assert.Contains("\"Topic\"", document.Text, StringComparison.Ordinal);
        Assert.Equal(before, TreeSnapshot.Of(_modFolder));
    }

    [Fact]
    public void RemovingAChildThenTheDocumentThatCarriedIt_AnswersTheDocumentsDeletionAlone()
    {
        var batch = SourceBatch.Over(Repository, []);

        Assert.Null(Write(batch, repository => repository.ChangesToRemove(Plugin, Identity(_response, "info"))));
        Assert.Null(Write(batch, repository => repository.ChangesToRemove(Plugin, Identity(_quest, "qust"))));

        Assert.Equal([FullPath(QuestPath)], batch.Changes.Deletions);
        Assert.Empty(batch.Changes.Documents);
        Assert.Null(batch.Repository.RecordOf(Plugin, Identity(_quest, "qust")).Value());
        Assert.True(File.Exists(FullPath(QuestPath)));
    }

    private IReadOnlyList<string> TreeTheBatchAnswers(Func<SourceRepository, SourceAnswer<SourceChanges>>[] writes)
    {
        var batch = SourceBatch.Over(Repository, []);
        foreach (var write in writes) Assert.Null(Write(batch, write));
        Assert.Null(SourceTransaction.Atomically(Repository, transaction => transaction.Apply(SourceAnswer.Of(batch.Changes))));
        return TreeSnapshot.Of(_modFolder);
    }

    private IReadOnlyList<string> TreeTheWritesLeaveOneAfterAnother(Func<SourceRepository, SourceAnswer<SourceChanges>>[] writes)
    {
        using var oneAfterAnother = new ScratchDirectory("medit-batch-sequence-");
        PluginBaselines.Track(oneAfterAnother, TheTree());
        var repository = SourceRepository.Over(TestMod.In(oneAfterAnother), Release);
        foreach (var write in writes)
            Assert.Null(SourceTransaction.Atomically(repository, transaction => transaction.Apply(write(repository))));
        return TreeSnapshot.Of(oneAfterAnother);
    }

    private SourceDocument Renamed(IMajorRecordGetter record, string recordType, string path, string editorId) =>
        new(record.FormKey.ToString(), recordType, editorId,
            File.ReadAllText(FullPath(path)).Replace($"\"{record.EditorID}\"", $"\"{editorId}\"", StringComparison.Ordinal));

    private static SourceDocument Child(IMajorRecordGetter record, string recordType) =>
        new(record.FormKey.ToString(), recordType, record.EditorID, RecordTextCodec.SerializeToText(record, Release));

    [Fact]
    public void ARenameThenARemovalFromTheRenamedDocument_AnswerTheTreeTheyLeave()
    {
        var renamed = Renamed(_quest, "qust", QuestPath, "Renamed");

        Func<SourceRepository, SourceAnswer<SourceChanges>>[] writes =
        [
            repository => repository.ChangesToPut(Plugin, renamed),
            repository => repository.ChangesToRemove(Plugin, Identity(_response, "info")),
        ];

        Assert.Equal(TreeTheWritesLeaveOneAfterAnother(writes), TreeTheBatchAnswers(writes));
    }

    [Fact]
    public void ARenameThenARemovalOfTheRenamedDocument_AnswerTheTreeTheyLeave()
    {
        var renamed = Renamed(_quest, "qust", QuestPath, "Renamed");

        Func<SourceRepository, SourceAnswer<SourceChanges>>[] writes =
        [
            repository => repository.ChangesToPut(Plugin, renamed),
            repository => repository.ChangesToRemove(Plugin, renamed.Identity),
        ];

        Assert.Equal(TreeTheWritesLeaveOneAfterAnother(writes), TreeTheBatchAnswers(writes));
    }

    [Fact]
    public void ARenamedContainerTakingAChild_AnswersTheTreeTheyLeave()
    {
        var renamed = Renamed(_cell, "cell", CellPath, "RenamedCell");
        var child = Child(new PlacedObject(_mod) { EditorID = "AddedRef" }, "refr");

        Func<SourceRepository, SourceAnswer<SourceChanges>>[] writes =
        [
            repository => repository.ChangesToPut(Plugin, renamed),
            repository => repository.ChangesToPutChild(Plugin, renamed.Identity, "Temporary", child),
        ];

        Assert.Equal(TreeTheWritesLeaveOneAfterAnother(writes), TreeTheBatchAnswers(writes));
    }

    [Fact]
    public void ANewDocumentThenItsRename_AnswerTheTreeTheyLeave()
    {
        var npc = new Npc(_mod) { EditorID = "NewNpc" };
        var created = Child(npc, "npc_");

        Func<SourceRepository, SourceAnswer<SourceChanges>>[] writes =
        [
            repository => repository.ChangesToPut(Plugin, created),
            repository => repository.ChangesToPut(Plugin, created with
            {
                EditorId = "RenamedNpc",
                Body = created.Body.Replace("\"NewNpc\"", "\"RenamedNpc\"", StringComparison.Ordinal),
            }),
        ];

        Assert.Equal(TreeTheWritesLeaveOneAfterAnother(writes), TreeTheBatchAnswers(writes));
    }

    [Fact]
    public void ARekeyedContainerThenItsRemoval_AnswerTheTreeTheyLeave()
    {
        var cell = Identity(_cell, "cell");
        var rekeyed = cell with { FormKey = $"000900:{PluginName}" };

        Func<SourceRepository, SourceAnswer<SourceChanges>>[] writes =
        [
            repository => repository.ChangesToRekey(Plugin, cell, rekeyed.FormKey),
            repository => repository.ChangesToRemove(Plugin, rekeyed),
        ];

        Assert.Equal(TreeTheWritesLeaveOneAfterAnother(writes), TreeTheBatchAnswers(writes));
    }

    [Fact]
    public void ARemovalInsideAContainersFolderThenTheContainersRename_AnswerTheTreeTheyLeave()
    {
        var renamed = Renamed(_worldspace, "wrld", WorldspacePath, "RenamedWorld");

        Func<SourceRepository, SourceAnswer<SourceChanges>>[] writes =
        [
            repository => repository.ChangesToRemove(Plugin, Identity(_exteriorCell, "cell")),
            repository => repository.ChangesToPut(Plugin, renamed),
        ];

        Assert.Equal(TreeTheWritesLeaveOneAfterAnother(writes), TreeTheBatchAnswers(writes));
    }

    [Fact]
    public void AnUnsavedTextNoWriteChanged_IsNoChange()
    {
        var batch = SourceBatch.Over(Repository, [new DocumentChange(FullPath(QuestPath), UnsavedQuest())]);

        Assert.Null(Write(batch, repository => repository.ChangesToRemove(Plugin, Identity(_exteriorCell, "cell"))));

        Assert.Empty(batch.Changes.Documents);
    }

    [Fact]
    public void AWriteOverAnUnsavedText_AnswersItWithTheWritesChange()
    {
        var batch = SourceBatch.Over(Repository, [new DocumentChange(FullPath(QuestPath), UnsavedQuest())]);

        Assert.Null(Write(batch, repository => repository.ChangesToRemove(Plugin, Identity(_response, "info"))));

        var document = Assert.Single(batch.Changes.Documents);
        Assert.Contains("\"UnsavedName\"", document.Text, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Response\"", document.Text, StringComparison.Ordinal);
    }

    [Fact]
    public void AWriteThatFails_LeavesTheBatchAsItWas()
    {
        var batch = SourceBatch.Over(Repository, []);
        Assert.Null(Write(batch, repository => repository.ChangesToRemove(Plugin, Identity(_response, "info"))));
        var before = batch.Changes;

        var failed = SourceTransaction.Atomically(batch.Repository, transaction =>
        {
            transaction.Apply(batch.Repository.ChangesToRemove(Plugin, Identity(_quest, "qust")));
            transaction.Apply(batch.Repository.ChangesToRemove(Plugin, Identity(_response, "info")));
        });

        Assert.IsType<SourceFailure.NotCarried>(failed);
        Assert.Equal(before.Deletions, batch.Changes.Deletions);
        Assert.Equal(before.Documents, batch.Changes.Documents);
        Assert.NotNull(batch.Repository.RecordOf(Plugin, Identity(_quest, "qust")).Value());
    }

    [Fact]
    public void TheChanges_NameEveryPathAbsolutely()
    {
        var batch = SourceBatch.Over(Repository, []);

        Assert.Null(Write(batch, repository => repository.ChangesToPut(Plugin, Renamed(_quest, "qust", QuestPath, "Renamed"))));
        Assert.Null(Write(batch, repository => repository.ChangesToRemove(Plugin, Identity(_cell, "cell"))));

        var (moves, deletions, documents) = batch.Changes;
        Assert.All(
            [.. moves.SelectMany(move => new[] { move.From, move.To }), .. deletions, .. documents.Select(document => document.Path)],
            path => Assert.StartsWith(_modFolder + Path.DirectorySeparatorChar, path, StringComparison.Ordinal));
        Assert.NotEmpty(moves);
        Assert.NotEmpty(deletions);
        Assert.NotEmpty(documents);
    }

    [Fact]
    public void AMoveOntoAPathARemovalInTheBatchFrees_IsADefect_AndLeavesTheBatchAsItWas()
    {
        var namesake = new Quest(_mod) { EditorID = "Quest" };
        var namesakePath = Path.Combine(PluginSourceRoot.For(PluginName), "Quests", $"Quest - {namesake.FormKey.ID:X6}_{PluginName}.json");
        File.WriteAllBytes(FullPath(namesakePath), Serialize(namesake));
        var batch = SourceBatch.Over(Repository, []);
        Assert.Null(Write(batch, repository => repository.ChangesToRemove(Plugin, Identity(_quest, "qust"))));
        var before = batch.Changes;

        var defect = Assert.Throws<InvalidOperationException>(() => Write(batch, repository =>
            repository.ChangesToRekey(Plugin, Identity(namesake, "qust"), _quest.FormKey.ToString())));

        Assert.Contains("a removal in it frees that path", defect.Message, StringComparison.Ordinal);
        Assert.Equal(before.Moves, batch.Changes.Moves);
        Assert.Equal(before.Deletions, batch.Changes.Deletions);
    }

    [Fact]
    public void AnUnsavedTextOfAFileTheDiskNoLongerHolds_StandsForNoDocument()
    {
        var batch = SourceBatch.Over(Repository, [new DocumentChange(FullPath(QuestPath), UnsavedQuest())]);

        File.Delete(FullPath(QuestPath));

        Assert.Null(batch.Repository.RecordOf(Plugin, Identity(_quest, "qust")).Value());
    }

    [Fact]
    public void AMoveIntoAFolderOnlyTheBatchsDocumentsMake_IsADefect_AndLeavesTheBatchAsItWas()
    {
        var folder = Path.Combine(PluginSourceRoot.For(PluginName), "Quests", "New");
        var batch = SourceBatch.Over(Repository, []);
        Assert.Null(Write(batch, _ => SourceAnswer.Of(new SourceChanges([], [], [new DocumentChange(Path.Combine(folder, "Other.json"), "{}")]))));
        var before = batch.Changes;

        var defect = Assert.Throws<InvalidOperationException>(() => Write(batch, _ =>
            SourceAnswer.Of(new SourceChanges([new SourceMove(QuestPath, Path.Combine(folder, "Quest.json"))], [], []))));

        Assert.Contains("only a document of the batch makes that folder", defect.Message, StringComparison.Ordinal);
        Assert.Equal(before.Moves, batch.Changes.Moves);
        Assert.Equal(before.Documents, batch.Changes.Documents);
    }

    [Fact]
    public void AReadAfterAFailedWrite_SeesNothingOfIt()
    {
        var batch = SourceBatch.Over(Repository, []);
        var created = Child(new Npc(_mod) { EditorID = "NewNpc" }, "npc_");
        bool HoldsTheNewNpc() =>
            batch.Repository.TreeOf(Plugin).Value().Files.Any(file => file.RelativePath.Contains("NewNpc", StringComparison.Ordinal));

        var failed = SourceTransaction.Atomically(batch.Repository, transaction =>
        {
            transaction.Apply(batch.Repository.ChangesToPut(Plugin, created));
            Assert.True(HoldsTheNewNpc());
            transaction.Apply(batch.Repository.ChangesToRemove(Plugin, new RecordIdentity($"00FFFF:{PluginName}", "info", "Absent")));
        });

        Assert.IsType<SourceFailure.NotCarried>(failed);
        Assert.False(HoldsTheNewNpc());
    }

    [Fact]
    public void ASecondAllocatorInTheBatch_ReadsTheHeaderAndTheFormKeysTheFirstLeft()
    {
        var batch = SourceBatch.Over(Repository, []);
        var created = Child(new Npc(_mod) { EditorID = "NewNpc" }, "npc_");
        var header = batch.Repository.RecordOf(Plugin, PluginHeader.IdentityOf(PluginName)).Value().Require();
        var movedPast = header with
        {
            Body = Encoding.UTF8.GetString(HeaderDocument.WithNextObjectId(Encoding.UTF8.GetBytes(header.Body), 0x900)),
        };

        Assert.Null(SourceTransaction.Atomically(batch.Repository, transaction =>
        {
            transaction.Apply(batch.Repository.ChangesToPut(Plugin, created));
            transaction.Apply(batch.Repository.ChangesToRewrite(Plugin, movedPast));
        }));

        var headerRead = batch.Repository.RecordOf(Plugin, PluginHeader.IdentityOf(PluginName)).Value().Require();
        Assert.Equal(0x900u, HeaderDocument.NextObjectId(Encoding.UTF8.GetBytes(headerRead.Body)));
        Assert.Contains(created.FormKey, batch.Repository.FormKeysUsed(Plugin).Value());
    }

    [Fact]
    public void AChildPutIntoAContainerTheBatchCreated_AnswersTheTreeTheyLeave()
    {
        var cell = Child(new Cell(_mod) { EditorID = "NewCell" }, "cell");
        var child = Child(new PlacedObject(_mod) { EditorID = "AddedRef" }, "refr");
        Func<SourceRepository, SourceAnswer<SourceChanges>>[] writes =
        [
            repository => repository.ChangesToPut(Plugin, cell),
            repository => repository.ChangesToPutChild(Plugin, cell.Identity, "Temporary", child),
        ];

        Assert.Equal(TreeTheWritesLeaveOneAfterAnother(writes), TreeTheBatchAnswers(writes));
    }

    [Theory]
    [InlineData("replace")]
    [InlineData("moveLast")]
    [InlineData("binary")]
    public void AVerbThatWritesTheDiskItself_RefusesOnABatchsRepository_AndWritesNothing(string verb)
    {
        var before = TreeSnapshot.Of(_modFolder);
        var batch = SourceBatch.Over(Repository, []);
        var wrote = false;

        Assert.Throws<InvalidOperationException>(() => verb switch
        {
            "replace" => batch.Repository.ReplaceSourceFrom(Plugin, [], "ABCDEF0123"),
            "moveLast" => batch.Repository.MoveLastWrittenTo(Plugin, "Renamed.esp"),
            _ => batch.Repository.WriteBinary(Plugin, "ABCDEF0123", () => wrote = true).Holds(out _, out var failure) ? null : failure,
        });

        Assert.False(wrote);
        Assert.Equal(before, TreeSnapshot.Of(_modFolder));
    }
}

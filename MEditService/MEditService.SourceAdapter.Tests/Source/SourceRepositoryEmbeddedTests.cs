using System.Text;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryEmbeddedTests : IDisposable
{
    private const string PluginName = "Embedded.esp";
    private static readonly PluginAddress Plugin = new(PluginName, "EmbeddedMod");
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private readonly ScratchDirectory _modFolder = new("medit-embedded-");
    private readonly RecordTextCodec _codec = new(NullLogger<RecordTextCodec>.Instance);

    private readonly Fallout4Mod _mod = new(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

    private readonly Cell _interiorCell;
    private readonly PlacedObject _persistentRef;
    private readonly PlacedObject _temporaryRef;
    private readonly Worldspace _worldspace;
    private readonly PlacedObject _topCellRef;
    private readonly Cell _exteriorCell;
    private readonly PlacedObject _exteriorRef;
    private readonly Quest _quest;
    private readonly DialogTopic _topic;
    private readonly DialogResponses _response;
    private readonly DialogResponses _response2;

    public SourceRepositoryEmbeddedTests()
    {
        _persistentRef = new PlacedObject(_mod) { EditorID = "PersistRef", Position = new P3Float(1f, 2f, 3f), Scale = 4f };
        _temporaryRef = new PlacedObject(_mod) { EditorID = "TempRef", Position = new P3Float(11f, 22f, 33f), Scale = 1f };
        _interiorCell = new Cell(_mod) { EditorID = "InteriorCell", WaterHeight = 100f };
        _interiorCell.Persistent.Add(_persistentRef);
        _interiorCell.Temporary.Add(_temporaryRef);

        _topCellRef = new PlacedObject(_mod) { EditorID = "TopCellRef", Position = new P3Float(7f, 8f, 9f), Scale = 6f };
        var topCell = new Cell(_mod) { EditorID = "TopCell", WaterHeight = 5f };
        topCell.Temporary.Add(_topCellRef);
        _worldspace = new Worldspace(_mod) { EditorID = "World", TopCell = topCell };

        _exteriorRef = new PlacedObject(_mod) { EditorID = "ExteriorRef", Position = new P3Float(4f, 5f, 6f), Scale = 2f };
        _exteriorCell = new Cell(_mod) { EditorID = "ExteriorCell", WaterHeight = 50f };
        _exteriorCell.Temporary.Add(_exteriorRef);

        _response = new DialogResponses(_mod) { EditorID = "Response" };
        _response2 = new DialogResponses(_mod) { EditorID = "Response2" };
        _topic = new DialogTopic(_mod) { EditorID = "Topic" };
        _topic.Responses.Add(_response);
        _topic.Responses.Add(_response2);
        _quest = new Quest(_mod) { EditorID = "Quest" };
        _quest.DialogTopics.Add(_topic);

        PluginBaselines.Track(
            _modFolder, TheFourDocumentsTheWholeModDoorWritesForThisGraph());
    }

    public void Dispose() => _modFolder.Dispose();

    private TreeFile[] TheFourDocumentsTheWholeModDoorWritesForThisGraph() =>
    [
        new(InteriorCellPath, Serialize(_interiorCell)),
        new(WorldspacePath, Serialize(_worldspace)),
        new(ExteriorCellPath, Serialize(_exteriorCell)),
        new(QuestPath, Serialize(_quest)),
    ];

    private static string Root => PluginSourceRoot.For(PluginName);

    private string InteriorCellPath =>
        Path.Combine(Root, "Cells", "0", "0", Leaf(_interiorCell), "RecordData.json");

    private string WorldspacePath =>
        Path.Combine(Root, "Worldspaces", Leaf(_worldspace), "RecordData.json");

    private string ExteriorCellPath =>
        Path.Combine(Root, "Worldspaces", Leaf(_worldspace), "0, 0", "0, 0", Leaf(_exteriorCell), "RecordData.json");

    private string QuestPath => Path.Combine(Root, "Quests", Leaf(_quest) + ".json");

    private static string Leaf(IMajorRecordGetter record) =>
        $"{record.EditorID} - {record.FormKey.ID:X6}_{record.FormKey.ModKey.FileName}";

    private byte[] Serialize(IMajorRecordGetter record) =>
        _codec.SerializeToBytes(record, Release);

    private SourceRepository Repository =>
        SourceRepository.Open(TestMod.In(_modFolder), Release) ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");

    private static RecordIdentity Identity(IMajorRecordGetter record, string recordType) =>
        new(record.FormKey.ToString(), recordType, record.EditorID);

    private string FullPath(string relativePath) => Path.Combine(_modFolder, relativePath);

    private void MoveTemporaryRef(Cell from, Cell to)
    {
        from.Temporary.Remove(_temporaryRef);
        to.Temporary.Add(_temporaryRef);
        File.WriteAllBytes(FullPath(InteriorCellPath), Serialize(_interiorCell));
        File.WriteAllBytes(FullPath(ExteriorCellPath), Serialize(_exteriorCell));
    }

    private static string? RootFormKeyWhichTellsAChildsOwnTextFromItsOwnersDocument(string body)
    {
        using var document = JsonDocument.Parse(body);
        return document.RootElement.TryGetProperty("FormKey", out var formKey) ? formKey.GetString() : null;
    }

    [Fact]
    public void Get_OfAPlacedReferenceInsideItsCell_IsTheChildsOwnText()
    {
        var body = Repository.Get(Plugin, Identity(_persistentRef, "refr"))?.Body;

        Assert.NotNull(body);
        Assert.Equal(_persistentRef.FormKey.ToString(), RootFormKeyWhichTellsAChildsOwnTextFromItsOwnersDocument(body));
        Assert.Contains("\"PersistRef\"", body, StringComparison.Ordinal);
        Assert.DoesNotContain("WaterHeight", body, StringComparison.Ordinal);
    }

    [Fact]
    public void Get_OfAnInteriorCell_IsTheTextOfItsOwnRecordDataJson()
    {
        var body = Repository.Get(Plugin, Identity(_interiorCell, "cell"))?.Body;

        Assert.Equal(File.ReadAllText(FullPath(InteriorCellPath)), body);
    }

    [Fact]
    public void Get_OfAnExteriorCell_IsFoundUnderItsWorldspacesOwnFolder()
    {
        var body = Repository.Get(Plugin, Identity(_exteriorCell, "cell"))?.Body;

        Assert.Equal(File.ReadAllText(FullPath(ExteriorCellPath)), body);
    }

    [Fact]
    public void Get_OfAPlacedReferenceInsideAnExteriorCell_ReadsThatCellsDirectoryAsACell()
    {
        var body = Repository.Get(Plugin, Identity(_exteriorRef, "refr"))?.Body;

        Assert.NotNull(body);
        Assert.Equal(_exteriorRef.FormKey.ToString(), RootFormKeyWhichTellsAChildsOwnTextFromItsOwnersDocument(body));
        Assert.DoesNotContain("WaterHeight", body, StringComparison.Ordinal);
    }

    [Fact]
    public void Get_OfAWorldspacesTopCellsPlacedReference_ReachesTwoEmbedLevelsDown()
    {
        var body = Repository.Get(Plugin, Identity(_topCellRef, "refr"))?.Body;

        Assert.NotNull(body);
        Assert.Equal(_topCellRef.FormKey.ToString(), RootFormKeyWhichTellsAChildsOwnTextFromItsOwnersDocument(body));
    }

    [Fact]
    public void Get_OfAQuestsDialogTopic_IsTheChildsOwnText()
    {
        var body = Repository.Get(Plugin, Identity(_topic, "dial"))?.Body;

        Assert.NotNull(body);
        Assert.Equal(_topic.FormKey.ToString(), RootFormKeyWhichTellsAChildsOwnTextFromItsOwnersDocument(body));
        Assert.Contains("\"Response2\"", body, StringComparison.Ordinal);
    }

    [Fact]
    public void Get_OfAResponseInsideAQuestsTopic_IsTheChildsOwnText()
    {
        var body = Repository.Get(Plugin, Identity(_response, "info"))?.Body;

        Assert.NotNull(body);
        Assert.Equal(_response.FormKey.ToString(), RootFormKeyWhichTellsAChildsOwnTextFromItsOwnersDocument(body));
        Assert.DoesNotContain("\"Response2\"", body, StringComparison.Ordinal);
    }

    private RecordIdentity? IdentityOf(IMajorRecordGetter record) =>
        Repository.Get(
            Plugin, record.FormKey.ToString(),
            SharedSchemaReflector.Instance.GetSchemas(Release))?.Identity;

    [Fact]
    public void Get_APlacedReferenceInsideItsCell_NamesItsTypeAndEditorId_FromTheTypeWrittenIntoItsOwnTextForItsSlotHoldsAnAbstractElementType()
    {
        Assert.Equal(
            new RecordIdentity(_persistentRef.FormKey.ToString(), "refr", "PersistRef"),
            IdentityOf(_persistentRef));
    }

    [Fact]
    public void Get_AResponseInsideAQuestsTopic_NamesTheTypeItsSlotHolds_ForAConcreteSlotLeavesNoTypeInTheDocument()
    {
        Assert.Equal(
            new RecordIdentity(_response.FormKey.ToString(), "info", "Response"),
            IdentityOf(_response));
    }

    [Fact]
    public void Get_ATopicInsideItsQuest_NamesTheTypeItsSlotHolds()
    {
        Assert.Equal(
            new RecordIdentity(_topic.FormKey.ToString(), "dial", "Topic"),
            IdentityOf(_topic));
    }

    [Fact]
    public void Get_AReferenceTwoEmbedLevelsDown_NamesItThroughTheWorldspacesTopCell()
    {
        Assert.Equal(
            new RecordIdentity(_topCellRef.FormKey.ToString(), "refr", "TopCellRef"),
            IdentityOf(_topCellRef));
    }

    private static IReadOnlyDictionary<string, RecordTableSchema> Schemas => SharedSchemaReflector.Instance.GetSchemas(Release);

    [Fact]
    public void Get_ByFormKey_OfAChildAnotherRecordsDocumentCarries_IsTheChildsOwnTextUnderItsIdentity()
    {
        var document = Repository.Get(Plugin, _topic.FormKey.ToString(), Schemas);

        Assert.Equal(Identity(_topic, "dial"), document?.Identity);
        Assert.Equal(Repository.Get(Plugin, Identity(_topic, "dial"))?.Body, document?.Body);
    }

    [Fact]
    public void Get_ByFormKey_OfAKeyNothingCarries_IsNull()
    {
        Assert.Null(Repository.Get(Plugin, "00FFFF:Embedded.esp", Schemas));
    }

    [Fact]
    public void Get_ByFormKey_OfAKeyWhoseDocumentIsNoRecordDocument_RefusesWithTheReadersWords()
    {
        File.WriteAllText(FullPath(Path.Combine(Root, "Quests", "Broken - 000FFF_Embedded.esp.json")), "[1]");

        var refused = Assert.Throws<UnreadableSourceDocumentException>(
            () => Repository.Get(Plugin, "000FFF:Embedded.esp", Schemas));

        Assert.Contains("000FFF:Embedded.esp", refused.Message, StringComparison.Ordinal);
        Assert.Contains("its root is not a JSON object", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ContainerOf_APlacedReferenceInsideItsCell_NamesTheCellAndTheSlot()
    {
        var container = Repository.ContainerOf(Plugin, Identity(_persistentRef, "refr"), Schemas);

        Assert.Equal(_interiorCell.FormKey.ToString(), container?.ParentFormKey);
        Assert.Equal("Persistent", container?.SlotName);
    }

    [Fact]
    public void ContainerOf_ATopicInsideItsQuest_NamesTheQuestAndTheSlot()
    {
        var container = Repository.ContainerOf(Plugin, Identity(_topic, "dial"), Schemas);

        Assert.Equal(_quest.FormKey.ToString(), container?.ParentFormKey);
        Assert.Equal("DialogTopics", container?.SlotName);
    }

    private void GiveTheInteriorCellsDocumentNoFormKey()
    {
        var path = FullPath(InteriorCellPath);
        File.WriteAllText(path, File.ReadAllText(path).Replace(_interiorCell.FormKey.ToString(), "NotAFormKey", StringComparison.Ordinal));
    }

    [Fact]
    public void ContainerDocument_OfAChildWhoseOwnerDocumentNamesNoRecord_RefusesWithTheReadersWords()
    {
        GiveTheInteriorCellsDocumentNoFormKey();

        var refused = Assert.Throws<UnreadableSourceDocumentException>(
            () => Repository.ContainerDocument(Plugin, Identity(_temporaryRef, "refr"), Schemas));

        Assert.Contains("names no document of its own", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ContainerOf_AChildWhoseOwnerDocumentNamesNoRecord_RefusesWithTheReadersWords()
    {
        GiveTheInteriorCellsDocumentNoFormKey();

        var refused = Assert.Throws<UnreadableSourceDocumentException>(
            () => Repository.ContainerOf(Plugin, Identity(_temporaryRef, "refr"), Schemas));

        Assert.Contains("names no document of its own", refused.Message, StringComparison.Ordinal);
    }

    private const string FreeFormKey = "000F00:Embedded.esp";

    private DocumentRekey Rekeying => new(
        (document, newKey) => RecordDocumentEdits.WithFormKey(_codec, document.Body, Release, document.RecordType, newKey),
        (owner, oldKey, newKey) => RecordDocumentEdits.WithEmbeddedChildFormKey(
            _codec, owner.Body, Release, owner.RecordType, oldKey, newKey));

    private static (IReadOnlyList<string> Gone, IReadOnlyList<string> Appeared) Difference(
        IReadOnlyList<string> before, IReadOnlyList<string> after) =>
        ([.. before.Except(after)], [.. after.Except(before)]);

    [Fact]
    public void Rekey_AnEmbeddedChild_RewritesOnlyTheOwnersDocument_AndRollbackPutsItBack()
    {
        var before = TreeSnapshot.Of(_modFolder);
        var transaction = new SourceTransaction();

        transaction.Rekey(Repository, Plugin, Identity(_temporaryRef, "refr"), FreeFormKey, Schemas, Rekeying);

        var (gone, appeared) = Difference(before, TreeSnapshot.Of(_modFolder));
        Assert.Single(gone);
        Assert.Single(appeared);
        Assert.StartsWith($"file {InteriorCellPath.Replace('\\', '/')} ", gone[0], StringComparison.Ordinal);
        Assert.StartsWith($"file {InteriorCellPath.Replace('\\', '/')} ", appeared[0], StringComparison.Ordinal);
        Assert.NotNull(Repository.Get(Plugin, FreeFormKey, Schemas));
        Assert.Null(Repository.Get(Plugin, _temporaryRef.FormKey.ToString(), Schemas));
        Assert.Empty(transaction.Undo(Repository));
        Assert.Equal(before, TreeSnapshot.Of(_modFolder));
    }

    [Fact]
    public void Rekey_AContainer_MovesItsChildRecordsFilesUnderTheNewKey_AndRollbackMovesThemBack()
    {
        var before = TreeSnapshot.Of(_modFolder);
        var transaction = new SourceTransaction();

        transaction.Rekey(Repository, Plugin, Identity(_worldspace, "wrld"), FreeFormKey, Schemas, Rekeying);

        var child = Repository.RelativePathOf(Plugin, Identity(_exteriorCell, "cell"));
        Assert.Contains("000F00_Embedded.esp", child, StringComparison.Ordinal);
        Assert.Null(Repository.RelativePathOf(Plugin, Identity(_worldspace, "wrld")));
        Assert.Empty(transaction.Undo(Repository));
        Assert.Equal(before, TreeSnapshot.Of(_modFolder));
    }

    [Fact]
    public void Rekey_ARecordWithAFileOfItsOwn_ReplacesThatFileUnderTheNewKey_AndRollbackPutsItBack()
    {
        var before = TreeSnapshot.Of(_modFolder);
        var transaction = new SourceTransaction();

        transaction.Rekey(Repository, Plugin, Identity(_quest, "qust"), FreeFormKey, Schemas, Rekeying);

        var (gone, appeared) = Difference(before, TreeSnapshot.Of(_modFolder));
        Assert.Single(gone);
        Assert.Single(appeared);
        Assert.Contains("Quests/", gone[0], StringComparison.Ordinal);
        Assert.Contains("000F00_Embedded.esp.json", appeared[0], StringComparison.Ordinal);
        Assert.Empty(transaction.Undo(Repository));
        Assert.Equal(before, TreeSnapshot.Of(_modFolder));
    }

    [Fact]
    public void Rekey_OfARecordNoDocumentCarries_RefusesBeforeTheTreeIsTouched()
    {
        var before = TreeSnapshot.Of(_modFolder);

        Assert.Throws<InvalidOperationException>(() => new SourceTransaction().Rekey(
            Repository, Plugin, new RecordIdentity("00FFFF:Embedded.esp", "refr", "Absent"), FreeFormKey, Schemas, Rekeying));
        Assert.Equal(before, TreeSnapshot.Of(_modFolder));
    }

    [Fact]
    public void Rekey_OfAChildItsOwnersTextDoesNotCarry_RefusesInOneSentence_BeforeTheTreeIsTouched()
    {
        var before = TreeSnapshot.Of(_modFolder);
        var ownerLacksIt = Rekeying with { ChildOfOwner = (_, _, _) => null };

        var refused = Assert.Throws<InvalidOperationException>(() => new SourceTransaction().Rekey(
            Repository, Plugin, Identity(_temporaryRef, "refr"), FreeFormKey, Schemas, ownerLacksIt));

        Assert.Contains("its own text does not carry it", refused.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("Nothing was written", refused.Message, StringComparison.Ordinal);
        Assert.Equal(before, TreeSnapshot.Of(_modFolder));
    }

    [Fact]
    public void ContainerOf_ARecordWithADocumentOfItsOwn_IsNull()
    {
        Assert.Null(Repository.ContainerOf(Plugin, Identity(_quest, "qust"), Schemas));
    }

    [Fact]
    public void Get_OfARecordNoDocumentCarries_IsNull()
    {
        Assert.Null(Repository.Get(Plugin, new RecordIdentity("00FFFF:Embedded.esp", "refr", "Absent")));
    }

    [Fact]
    public void Get_AfterAHandEditMovedAChildToAnotherOwner_FindsItAtTheNewOwner_NotFromTheMapBuiltBeforeTheMove()
    {
        var repository = Repository;
        Assert.NotNull(repository.Get(Plugin, Identity(_temporaryRef, "refr")));

        MoveTemporaryRef(_interiorCell, _exteriorCell);

        var found = repository.Get(Plugin, Identity(_temporaryRef, "refr"));
        Assert.NotNull(found);
        Assert.Equal(_temporaryRef.FormKey.ToString(), RootFormKeyWhichTellsAChildsOwnTextFromItsOwnersDocument(found.Body));
        Assert.Equal(
            Path.GetRelativePath(_modFolder, FullPath(ExteriorCellPath)),
            repository.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")));
    }

    [Fact]
    public void RelativePathOf_AChildMovedTwiceWithinOneOperation_IsAbsentNeverTheOwnerThatLostIt()
    {
        var repository = Repository;
        Assert.NotNull(repository.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")));
        MoveTemporaryRef(_interiorCell, _exteriorCell);
        Assert.NotNull(repository.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")));

        MoveTemporaryRef(_exteriorCell, _interiorCell);

        Assert.Null(repository.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")));
    }

    [Fact]
    public void RelativePathOf_ForAChildInsideADocumentOfAPathAmbiguousGroup_FindsThatDocument_ThoughGlobalsMapsToFourTypesSoOnlyTheDocumentNamesItsOwn()
    {
        var folder = RecordTypeDispatch.For(Release).FolderNameFor("globalfloat")
            ?? throw new InvalidOperationException("Expected 'globalfloat' to resolve to a group folder.");
        var carrier = Path.Combine(_modFolder, Root, folder, "Carrier - 00A000_Embedded.esp.json");
        Directory.CreateDirectory(Path.GetDirectoryName(carrier) ?? throw new InvalidOperationException($"Expected '{carrier}' to have a parent directory."));
        File.WriteAllText(
            carrier,
            "{\n  \"MutagenObjectType\": \"GlobalFloat\",\n  \"FormKey\": \"00A000:Embedded.esp\",\n" +
            "  \"Temporary\": [ { \"FormKey\": \"00A001:Embedded.esp\" } ]\n}");

        var child = new RecordIdentity("00A001:Embedded.esp", "refr", null);

        Assert.Equal(Path.GetRelativePath(_modFolder, carrier), Repository.RelativePathOf(Plugin, child));
        Assert.Equal("00A000:Embedded.esp", Repository.ContainerDocument(Plugin, child, Schemas)?.FormKey);
    }

    [Fact]
    public void Put_OfAPlacedReference_LandsInTheCellsDocument_LeavingTheCellsOwnFieldsAlone()
    {
        var repository = Repository;
        var renamed = new PlacedObject(_persistentRef.FormKey, Fallout4Release.Fallout4)
        {
            EditorID = "RenamedRef",
            Position = new P3Float(9f, 9f, 9f),
            Scale = 4f,
        };

        repository.Put(
            Plugin,
            new SourceDocument(
                _persistentRef.FormKey.ToString(), "refr", "RenamedRef", Encoding.UTF8.GetString(Serialize(renamed))));

        var cellText = File.ReadAllText(FullPath(InteriorCellPath));
        Assert.Contains("\"RenamedRef\"", cellText, StringComparison.Ordinal);
        Assert.DoesNotContain("\"PersistRef\"", cellText, StringComparison.Ordinal);
        Assert.Contains("\"WaterHeight\": 100.0", cellText, StringComparison.Ordinal);
        Assert.Contains("\"TempRef\"", cellText, StringComparison.Ordinal);
    }

    [Fact]
    public void Remove_OfAnEmbeddedChild_LeavesTheOwnersOtherChildrenIntact()
    {
        var repository = Repository;

        Assert.Equal(SourceRemoval.Removed, repository.Remove(Plugin, Identity(_response, "info")));

        var questText = File.ReadAllText(FullPath(QuestPath));
        Assert.DoesNotContain("\"Response\"", questText, StringComparison.Ordinal);
        Assert.Contains("\"Response2\"", questText, StringComparison.Ordinal);
        Assert.Contains("\"Topic\"", questText, StringComparison.Ordinal);
        Assert.Null(repository.Get(Plugin, Identity(_response, "info")));
        Assert.NotNull(repository.Get(Plugin, Identity(_response2, "info")));
    }

    [Fact]
    public void Remove_OfARecordNoDocumentHolds_SaysNoDocumentHoldsIt()
    {
        Assert.Equal(
            SourceRemoval.NoDocumentHoldsIt,
            Repository.Remove(Plugin, new RecordIdentity("00FFFF:Embedded.esp", "refr", "Absent")));
    }

    [Fact]
    public void RelativePathOf_ForAKeyADocumentNamesOutsideEveryEmbedSlot_FindsNoOwner_ForAFormKeyAnywhereElseIsAReferenceNotAChild()
    {
        var quest = File.ReadAllText(FullPath(QuestPath));
        File.WriteAllText(
            FullPath(QuestPath),
            quest.TrimEnd().TrimEnd('}') + ",\n  \"NotAChild\": { \"FormKey\": \"00A001:Embedded.esp\" }\n}");

        var identity = new RecordIdentity("00A001:Embedded.esp", "refr", "Absent");

        Assert.Null(Repository.RelativePathOf(Plugin, identity));
        Assert.Equal(SourceRemoval.NoDocumentHoldsIt, Repository.Remove(Plugin, identity));
    }

    [Fact]
    public void Remove_OfAKeyASlotNamesButTheRecordDoesNotCarry_SaysTheOwnersTextLacksIt_ForOnlyTheCodecsObjectModelCanSayTheRecordHasNoSuchMember()
    {
        var quest = File.ReadAllText(FullPath(QuestPath));
        File.WriteAllText(
            FullPath(QuestPath),
            quest.TrimEnd().TrimEnd('}') + ",\n  \"Persistent\": [ { \"FormKey\": \"00A001:Embedded.esp\" } ]\n}");

        Assert.Equal(
            SourceRemoval.OwnerDoesNotCarryIt,
            Repository.Remove(Plugin, new RecordIdentity("00A001:Embedded.esp", "refr", "Absent")));
    }

    [Fact]
    public void Remove_OfAContainerWithADirectoryOfItsOwn_TakesTheWholeDirectory()
    {
        var repository = Repository;

        Assert.Equal(SourceRemoval.Removed, repository.Remove(Plugin, Identity(_exteriorCell, "cell")));

        Assert.False(Directory.Exists(Path.GetDirectoryName(FullPath(ExteriorCellPath))));
        Assert.Null(repository.Get(Plugin, Identity(_exteriorCell, "cell")));
        Assert.NotNull(repository.Get(Plugin, Identity(_worldspace, "wrld")));
    }

    [Fact]
    public void FormKeysUsed_IncludesEveryEmbeddedChildsFormKey_InThreeDifferentOwnersSlots()
    {
        var held = Repository.FormKeysUsed(Plugin);

        Assert.Contains(_persistentRef.FormKey.ToString(), held);
        Assert.Contains(_temporaryRef.FormKey.ToString(), held);
        Assert.Contains(_topCellRef.FormKey.ToString(), held);
        Assert.Contains(_exteriorRef.FormKey.ToString(), held);
        Assert.Contains(_topic.FormKey.ToString(), held);
        Assert.Contains(_response.FormKey.ToString(), held);
        Assert.Contains(_response2.FormKey.ToString(), held);
    }

    [Fact]
    public void RelativePathOf_OfAChildAnotherToolMovedBetweenTwoOperations_IsItsNewOwner()
    {
        Assert.NotNull(Repository.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")));

        MoveTemporaryRef(_interiorCell, _exteriorCell);

        Assert.Equal(
            Path.GetRelativePath(_modFolder, FullPath(ExteriorCellPath)),
            Repository.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")));
    }

    [Fact]
    public void Get_AChildAnotherToolDeletedBetweenTwoOperations_IsNothing()
    {
        Assert.NotNull(IdentityOf(_temporaryRef));

        _interiorCell.Temporary.Remove(_temporaryRef);
        File.WriteAllBytes(FullPath(InteriorCellPath), Serialize(_interiorCell));

        Assert.Null(IdentityOf(_temporaryRef));
    }

    [Fact]
    public void Get_AChildInADocumentAnotherToolAddedBetweenTwoOperations_NamesIt()
    {
        var added = new PlacedObject(_mod) { EditorID = "AddedRef", Position = new P3Float(1f, 1f, 1f), Scale = 1f };
        Assert.Null(IdentityOf(added));

        var cell = new Cell(_mod) { EditorID = "AddedCell" };
        cell.Temporary.Add(added);
        var path = FullPath(Path.Combine(Root, "Cells", "0", "0", Leaf(cell), "RecordData.json"));
        Directory.CreateDirectory(Path.GetDirectoryName(path) ?? throw new InvalidOperationException($"Expected '{path}' to have a parent directory."));
        File.WriteAllBytes(path, Serialize(cell));

        Assert.Equal(new RecordIdentity(added.FormKey.ToString(), "refr", "AddedRef"), IdentityOf(added));
    }

    [Fact]
    public void RelativePathOf_OfAChildWhoseOwnerAnotherToolRenamedBetweenTwoOperations_IsTheRenamedDocument()
    {
        Assert.NotNull(Repository.RelativePathOf(Plugin, Identity(_response, "info")));

        var renamed = Path.Combine(Root, "Quests", "Renamed by hand.json");
        File.Move(FullPath(QuestPath), FullPath(renamed));

        Assert.Equal(renamed, Repository.RelativePathOf(Plugin, Identity(_response, "info")));
    }

    [Fact]
    public void Get_AChildAnotherToolRewroteUnderAnotherEditorIdBetweenTwoOperations_NamesTheNewEditorId()
    {
        Assert.Equal("TempRef", IdentityOf(_temporaryRef)?.EditorId);

        _temporaryRef.EditorID = "RewrittenRef";
        File.WriteAllBytes(FullPath(InteriorCellPath), Serialize(_interiorCell));

        Assert.Equal("RewrittenRef", IdentityOf(_temporaryRef)?.EditorId);
    }

    [Fact]
    public void Get_AChildWhoseOwnerAnotherToolDeletedBetweenTwoOperations_IsNothing()
    {
        Assert.NotNull(IdentityOf(_response));

        File.Delete(FullPath(QuestPath));

        Assert.Null(IdentityOf(_response));
    }

    [Fact]
    public void RelativePathOf_OfAChildWhoseOwnerAnotherToolMovedToAnotherFolderBetweenTwoOperations_IsTheMovedDocument()
    {
        Assert.NotNull(Repository.RelativePathOf(Plugin, Identity(_persistentRef, "refr")));

        var moved = Path.Combine(Root, "Cells", "1", "1", Leaf(_interiorCell));
        Directory.CreateDirectory(Path.GetDirectoryName(FullPath(moved)) ?? throw new InvalidOperationException($"Expected '{moved}' to have a parent directory."));
        Directory.Move(Path.GetDirectoryName(FullPath(InteriorCellPath)) ?? throw new InvalidOperationException("Expected the interior cell's document to sit in its own directory."), FullPath(moved));

        Assert.Equal(
            Path.Combine(moved, "RecordData.json"),
            Repository.RelativePathOf(Plugin, Identity(_persistentRef, "refr")));
    }

    [Fact]
    public void RelativePathOf_OfAChildAnotherToolCopiedIntoASecondOwnerBetweenTwoOperations_IsRefusedAsAmbiguous()
    {
        Assert.NotNull(Repository.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")));

        _exteriorCell.Temporary.Add(_temporaryRef);
        File.WriteAllBytes(FullPath(ExteriorCellPath), Serialize(_exteriorCell));

        Assert.Throws<AmbiguousSourceUnitException>(() => Repository.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")));
    }

    [Fact]
    public void RelativePathOf_OfAChildWhoseFormKeyAnotherToolWroteThroughAJsonEscape_IsItsOwner()
    {
        var formKey = _temporaryRef.FormKey.ToString();
        var escaped = $"\"{formKey.Replace(":", "\\u003A", StringComparison.Ordinal)}\"";
        var text = File.ReadAllText(FullPath(InteriorCellPath));
        File.WriteAllText(FullPath(InteriorCellPath), text.Replace($"\"{formKey}\"", escaped, StringComparison.Ordinal));

        Assert.Contains(escaped, File.ReadAllText(FullPath(InteriorCellPath)), StringComparison.Ordinal);
        Assert.Equal(
            Path.GetRelativePath(_modFolder, FullPath(InteriorCellPath)),
            Repository.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")));
    }

    [Fact]
    public void Get_EveryEmbeddedChildAskedInOneOperation_NamesEachOne()
    {
        var repository = Repository;
        var schemas = SharedSchemaReflector.Instance.GetSchemas(Release);
        IMajorRecordGetter[] children = [_persistentRef, _temporaryRef, _topCellRef, _exteriorRef, _topic, _response, _response2];

        var named = children.Select(child => repository.Get(Plugin, child.FormKey.ToString(), schemas)?.EditorId);

        Assert.Equal(children.Select(child => child.EditorID), named);
    }
}

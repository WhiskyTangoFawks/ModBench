using System.Text;
using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.TestSupport;
using MEditService.TestSupport.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.SourceRepo.Tests.Source;

/// <summary>The repository's document verbs for the records no path names: a container's own
/// directory, and a child inlined in another document. Turning an identity into a path is its work
/// alone (ADR-0014 invariant 5).</summary>
public sealed class SourceRepositoryEmbeddedTests : IDisposable
{
    private const string PluginName = "Embedded.esp";
    private static readonly PluginCopyKey Plugin = new(PluginName, "EmbeddedMod");
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-embedded-").FullName;
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

        SourceRepository.Track(
            _modFolder, SourcePreset.Edits, PristineFiles(), new TrackProvenance(null, null, new Dictionary<string, string>()));
    }

    public void Dispose()
    {
        try { Directory.Delete(_modFolder, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
        catch (UnauthorizedAccessException) { /* ditto */ }
    }

    // The four documents the whole-mod door writes for this graph.
    private TreeFile[] PristineFiles() =>
    [
        new(InteriorCellPath, Serialize(_interiorCell)),
        new(WorldspacePath, Serialize(_worldspace)),
        new(ExteriorCellPath, Serialize(_exteriorCell)),
        new(QuestPath, Serialize(_quest)),
    ];

    private static string Root => SourceRepository.RootFor(PluginName);

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
        SourceRepository.Open(_modFolder, Release) ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");

    private static RecordIdentity Identity(IMajorRecordGetter record, string recordType) =>
        new(record.FormKey.ToString(), recordType, record.EditorID);

    private string FullPath(string relativePath) => Path.Combine(_modFolder, relativePath);

    // The root FormKey tells a child's own text from its owner's document, which carries the child's
    // key further down.
    private static string? RootFormKeyOf(string body)
    {
        using var document = JsonDocument.Parse(body);
        return document.RootElement.TryGetProperty("FormKey", out var formKey) ? formKey.GetString() : null;
    }

    [Fact]
    public void Get_OfAPlacedReferenceInsideItsCell_IsTheChildsOwnText()
    {
        var body = Repository.Get(Plugin, Identity(_persistentRef, "refr"))?.Body;

        Assert.NotNull(body);
        Assert.Equal(_persistentRef.FormKey.ToString(), RootFormKeyOf(body));
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
        Assert.Equal(_exteriorRef.FormKey.ToString(), RootFormKeyOf(body));
        Assert.DoesNotContain("WaterHeight", body, StringComparison.Ordinal);
    }

    [Fact]
    public void Get_OfAWorldspacesTopCellsPlacedReference_ReachesTwoEmbedLevelsDown()
    {
        var body = Repository.Get(Plugin, Identity(_topCellRef, "refr"))?.Body;

        Assert.NotNull(body);
        Assert.Equal(_topCellRef.FormKey.ToString(), RootFormKeyOf(body));
    }

    [Fact]
    public void Get_OfAQuestsDialogTopic_IsTheChildsOwnText()
    {
        var body = Repository.Get(Plugin, Identity(_topic, "dial"))?.Body;

        Assert.NotNull(body);
        Assert.Equal(_topic.FormKey.ToString(), RootFormKeyOf(body));
        Assert.Contains("\"Response2\"", body, StringComparison.Ordinal);
    }

    [Fact]
    public void Get_OfAResponseInsideAQuestsTopic_IsTheChildsOwnText()
    {
        var body = Repository.Get(Plugin, Identity(_response, "info"))?.Body;

        Assert.NotNull(body);
        Assert.Equal(_response.FormKey.ToString(), RootFormKeyOf(body));
        Assert.DoesNotContain("\"Response2\"", body, StringComparison.Ordinal);
    }

    private RecordIdentity? IdentityOf(IMajorRecordGetter record) =>
        Repository.IdentityOf(
            Plugin, record.FormKey.ToString(),
            SharedSchemaReflector.Instance.GetSchemas(Release));

    // The child's type is written into its own text, since a placed reference's slot holds an
    // abstract element type.
    [Fact]
    public void IdentityOf_APlacedReferenceInsideItsCell_NamesItsTypeAndEditorId()
    {
        Assert.Equal(
            new RecordIdentity(_persistentRef.FormKey.ToString(), "refr", "PersistRef"),
            IdentityOf(_persistentRef));
    }

    // The one its own text cannot answer: a topic's slot holds a concrete class, so the document
    // carries no type of its own and only the slot says what it holds.
    [Fact]
    public void IdentityOf_AResponseInsideAQuestsTopic_NamesTheTypeItsSlotHolds()
    {
        Assert.Equal(
            new RecordIdentity(_response.FormKey.ToString(), "info", "Response"),
            IdentityOf(_response));
    }

    [Fact]
    public void IdentityOf_ATopicInsideItsQuest_NamesTheTypeItsSlotHolds()
    {
        Assert.Equal(
            new RecordIdentity(_topic.FormKey.ToString(), "dial", "Topic"),
            IdentityOf(_topic));
    }

    [Fact]
    public void IdentityOf_AReferenceTwoEmbedLevelsDown_NamesItThroughTheWorldspacesTopCell()
    {
        Assert.Equal(
            new RecordIdentity(_topCellRef.FormKey.ToString(), "refr", "TopCellRef"),
            IdentityOf(_topCellRef));
    }

    [Fact]
    public void Get_OfARecordNoDocumentCarries_IsNull()
    {
        Assert.Null(Repository.Get(Plugin, new RecordIdentity("00FFFF:Embedded.esp", "refr", "Absent")));
    }

    [Fact]
    public void Get_AfterAHandEditMovedAChildToAnotherOwner_FindsItAtTheNewOwner()
    {
        var repository = Repository;
        // Asked once first, so the answer below can only come from a map that noticed the move.
        Assert.NotNull(repository.Get(Plugin, Identity(_temporaryRef, "refr")));

        _interiorCell.Temporary.Remove(_temporaryRef);
        _exteriorCell.Temporary.Add(_temporaryRef);
        File.WriteAllBytes(FullPath(InteriorCellPath), Serialize(_interiorCell));
        File.WriteAllBytes(FullPath(ExteriorCellPath), Serialize(_exteriorCell));

        var found = repository.Get(Plugin, Identity(_temporaryRef, "refr"));
        Assert.NotNull(found);
        Assert.Equal(_temporaryRef.FormKey.ToString(), RootFormKeyOf(found.Body));
        Assert.Equal(
            Path.GetRelativePath(_modFolder, FullPath(ExteriorCellPath)),
            repository.UnitHolding(Plugin, Identity(_temporaryRef, "refr"))?.RelativePath);
    }

    [Fact]
    public void UnitHolding_AfterTheMapHasRebuiltOnce_AnswersAbsentForAChildTheListedOwnerHasLost()
    {
        var repository = Repository;
        // A miss spends this repository's one rebuild, so the move below cannot buy a second.
        Assert.Null(repository.Get(Plugin, new RecordIdentity("00FFFF:Embedded.esp", "refr", "Absent")));

        _interiorCell.Temporary.Remove(_temporaryRef);
        _exteriorCell.Temporary.Add(_temporaryRef);
        File.WriteAllBytes(FullPath(InteriorCellPath), Serialize(_interiorCell));
        File.WriteAllBytes(FullPath(ExteriorCellPath), Serialize(_exteriorCell));

        // Absent, never the interior cell the map still lists: an answer the tree does not bear out
        // would send a write into a document that does not carry the record.
        Assert.Null(repository.UnitHolding(Plugin, Identity(_temporaryRef, "refr")));
    }

    [Fact]
    public void UnitHolding_ForAChildInsideADocumentOfAPathAmbiguousGroup_FindsThatDocument()
    {
        // "Globals" maps to GlobalBool/Float/Int/Short, so no path can name the type; the document
        // names its own, and the map still has to carry the children it holds.
        var folder = RecordTypeDispatch.For(Release).FolderNameFor("globalfloat")
            ?? throw new InvalidOperationException("Expected 'globalfloat' to resolve to a group folder.");
        var carrier = Path.Combine(_modFolder, Root, folder, "Carrier - 00A000_Embedded.esp.json");
        Directory.CreateDirectory((Path.GetDirectoryName(carrier) ?? throw new InvalidOperationException("Expected a parent directory.")));
        File.WriteAllText(
            carrier,
            "{\n  \"MutagenObjectType\": \"GlobalFloat\",\n  \"FormKey\": \"00A000:Embedded.esp\",\n" +
            "  \"Temporary\": [ { \"FormKey\": \"00A001:Embedded.esp\" } ]\n}");

        var unit = Repository.UnitHolding(Plugin, new RecordIdentity("00A001:Embedded.esp", "refr", null));

        Assert.NotNull(unit);
        Assert.Equal(Path.GetRelativePath(_modFolder, carrier), unit.RelativePath);
        Assert.True(unit.IsEmbedded);
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
    public void UnitHolding_ForAKeyADocumentNamesOutsideEveryEmbedSlot_FindsNoOwner()
    {
        // The codec writes a link as a bare string under its own field name and a child as an object
        // inside the slot its container embeds; a FormKey anywhere else is a reference, not a child.
        var quest = File.ReadAllText(FullPath(QuestPath));
        File.WriteAllText(
            FullPath(QuestPath),
            quest.TrimEnd().TrimEnd('}') + ",\n  \"NotAChild\": { \"FormKey\": \"00A001:Embedded.esp\" }\n}");

        var identity = new RecordIdentity("00A001:Embedded.esp", "refr", "Absent");

        Assert.Null(Repository.UnitHolding(Plugin, identity));
        Assert.Equal(SourceRemoval.NoDocumentHoldsIt, Repository.Remove(Plugin, identity));
    }

    [Fact]
    public void Remove_OfAKeyASlotNamesButTheRecordDoesNotCarry_SaysTheOwnersTextLacksIt()
    {
        // A slot the quest itself has no member for: the map reads the name and answers, and only the
        // codec's own object model can say the record does not carry it.
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
}

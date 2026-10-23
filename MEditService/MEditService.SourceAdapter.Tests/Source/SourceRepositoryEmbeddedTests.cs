using System.Text;
using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryEmbeddedTests : IDisposable
{
    private const string PluginName = "Embedded.esp";
    private static readonly PluginAddress Plugin = new(PluginName, TestMod.Name);
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private readonly ScratchDirectory _modFolder = new("medit-embedded-");

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

        PluginBaselines.Init(
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
        PluginSourceRoot.ContainerDocument(Path.Combine(Root, "Cells", "0", "0", Leaf(_interiorCell)));

    private string WorldspacePath =>
        PluginSourceRoot.ContainerDocument(Path.Combine(Root, "Worldspaces", Leaf(_worldspace)));

    private string ExteriorCellPath =>
        PluginSourceRoot.ContainerDocument(Path.Combine(Root, "Worldspaces", Leaf(_worldspace), "0, 0", "0, 0", Leaf(_exteriorCell)));

    private string QuestPath => Path.Combine(Root, "Quests", Leaf(_quest) + ".json");

    private static string Leaf(IMajorRecordGetter record) =>
        $"{record.EditorID} - {record.FormKey.ID:X6}_{record.FormKey.ModKey.FileName}";

    private static byte[] Serialize(IMajorRecordGetter record) =>
        Encoding.UTF8.GetBytes(RecordTextCodec.SerializeToText(record, Release));

    private ISourceRepository? _repository;

    private ISourceRepository Repository => _repository ??= TheNextOperation;

    private ISourceRepository TheNextOperation => TestAdapters.OpenSourceMod(_modFolder, Release);

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

    public enum Read
    {
        Get,
        GetByFormKey,
        RecordFromText,
        EditorIdsHeld,
        ReadingTheTree,
    }

    private SourceFailure Stopped(Read read, IMajorRecordGetter record, string recordType, string documentPath) =>
        read switch
        {
            Read.Get => Repository.RecordOf(Plugin, Identity(record, recordType)).Stopped(),
            Read.GetByFormKey => Repository.RecordByFormKey(Plugin, record.FormKey.ToString()).Stopped(),
            Read.RecordFromText => Repository.RecordFromText(Plugin, record.FormKey.ToString(), File.ReadAllText(FullPath(documentPath))).Stopped(),
            Read.EditorIdsHeld => Repository.EditorIdsHeld(Plugin).Stopped(),
            Read.ReadingTheTree => Repository.ReadDocuments(Plugin, tree => tree.Records.ToList()).Stopped(),
            _ => throw new ArgumentOutOfRangeException(nameof(read), read, null),
        };

    private static string? RootFormKeyWhichTellsAChildsOwnTextFromItsOwnersDocument(string body)
    {
        using var document = JsonDocument.Parse(body);
        return document.RootElement.TryGetProperty("FormKey", out var formKey) ? formKey.GetString() : null;
    }

    public enum Child
    {
        PersistentRef,
        TemporaryRef,
        ExteriorRef,
        TopCellRef,
        Topic,
        Response,
    }

    private (IMajorRecordGetter Record, string RecordType) Embedded(Child child) =>
        child switch
        {
            Child.PersistentRef => (_persistentRef, "refr"),
            Child.TemporaryRef => (_temporaryRef, "refr"),
            Child.ExteriorRef => (_exteriorRef, "refr"),
            Child.TopCellRef => (_topCellRef, "refr"),
            Child.Topic => (_topic, "dial"),
            Child.Response => (_response, "info"),
            _ => throw new ArgumentOutOfRangeException(nameof(child), child, null),
        };

    private static string? RootEditorId(string body)
    {
        using var document = JsonDocument.Parse(body);
        return document.RootElement.GetProperty("EditorID").GetString();
    }

    private RecordIdentity? IdentityOf(IMajorRecordGetter record) =>
        Repository.RecordByFormKey(
            Plugin, record.FormKey.ToString()).Value()?.Identity;

    [Theory]
    [InlineData(Child.PersistentRef)]
    [InlineData(Child.TemporaryRef)]
    [InlineData(Child.ExteriorRef)]
    [InlineData(Child.TopCellRef)]
    [InlineData(Child.Topic)]
    [InlineData(Child.Response)]
    public void AnEmbeddedChild_IsItsOwnText_UnderTheTypeItsSlotHoldsAndItsOwnEditorId(Child child)
    {
        var (record, recordType) = Embedded(child);

        var document = Repository.RecordByFormKey(Plugin, record.FormKey.ToString()).Value().Require();

        Assert.Equal(Identity(record, recordType), document.Identity);
        Assert.Equal(Repository.RecordOf(Plugin, Identity(record, recordType)).Value()?.Body, document.Body);
        Assert.Equal(record.FormKey.ToString(), RootFormKeyWhichTellsAChildsOwnTextFromItsOwnersDocument(document.Body));
        Assert.Equal(record.EditorID, RootEditorId(document.Body));
    }

    [Fact]
    public void AnEmbeddedChild_CarriesTheChildrenItEmbeds()
    {
        var topic = Repository.RecordByFormKey(Plugin, _topic.FormKey.ToString()).Value()?.Body;

        Assert.Contains("\"Response2\"", topic, StringComparison.Ordinal);
    }

    [Fact]
    public void Get_OfAnInteriorCell_IsTheTextOfItsOwnRecordDataJson()
    {
        var body = Repository.RecordOf(Plugin, Identity(_interiorCell, "cell")).Value()?.Body;

        Assert.Equal(File.ReadAllText(FullPath(InteriorCellPath)), body);
    }

    [Fact]
    public void Get_OfAnExteriorCell_IsFoundUnderItsWorldspacesOwnFolder()
    {
        var body = Repository.RecordOf(Plugin, Identity(_exteriorCell, "cell")).Value()?.Body;

        Assert.Equal(File.ReadAllText(FullPath(ExteriorCellPath)), body);
    }

    [Fact]
    public void Get_ByFormKey_OfAKeyNothingCarries_IsNull()
    {
        Assert.Null(Repository.RecordByFormKey(Plugin, "00FFFF:Embedded.esp").Value());
    }

    [Fact]
    public void Get_ByFormKey_OfAKeyWhoseDocumentIsNoRecordDocument_RefusesWithTheReadersWords()
    {
        File.WriteAllText(FullPath(Path.Combine(Root, "Quests", "Broken - 000FFF_Embedded.esp.json")), "[1]");

        var refused = Assert.IsType<SourceFailure.Unreadable>(Repository.RecordByFormKey(Plugin, "000FFF:Embedded.esp").Stopped());

        Assert.Contains("000FFF:Embedded.esp", refused.Reason, StringComparison.Ordinal);
        Assert.Contains("its root is not a JSON object", refused.Reason, StringComparison.Ordinal);
    }

    private void GiveANumberForTheEditorId(string relativePath, string editorId)
    {
        var path = FullPath(relativePath);
        var text = File.ReadAllText(path);
        var edited = text.Replace($"\"EditorID\": \"{editorId}\"", "\"EditorID\": 5", StringComparison.Ordinal);
        Assert.NotEqual(text, edited);
        File.WriteAllText(path, edited);
    }

    [Theory]
    [InlineData(Read.GetByFormKey)]
    [InlineData(Read.EditorIdsHeld)]
    public void ARecordsEditorIdThatIsNoString_RefusesNamingItsFileAndTheField(Read read)
    {
        GiveANumberForTheEditorId(QuestPath, "Quest");

        var refused = Assert.IsType<SourceFailure.Unreadable>(Stopped(read, _quest, "qust", QuestPath));

        Assert.Equal((QuestPath, _quest.FormKey.ToString()), (refused.File?.SourceRelativePath, refused.File?.FormKey));
        Assert.Contains("its 'EditorID' is not a string", refused.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void Get_ByFormKey_OfAChildWhoseEditorIdIsNoString_RefusesNamingItsOwnersFileAndTheField()
    {
        GiveANumberForTheEditorId(InteriorCellPath, "TempRef");

        var refused = Assert.IsType<SourceFailure.Unreadable>(Repository.RecordByFormKey(Plugin, _temporaryRef.FormKey.ToString()).Stopped());

        Assert.Equal((InteriorCellPath, _temporaryRef.FormKey.ToString()), (refused.File?.SourceRelativePath, refused.File?.FormKey));
        Assert.Contains($"its 'Temporary' names '{_temporaryRef.FormKey}', whose 'EditorID' is not a string", refused.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void EditorIdsHeld_WhenAnEmbeddedChildsEditorIdIsNoString_RefusesNamingItsOwnersFileAndTheField()
    {
        GiveANumberForTheEditorId(InteriorCellPath, "TempRef");

        var refused = Assert.IsType<SourceFailure.Unreadable>(Repository.EditorIdsHeld(Plugin).Stopped());

        Assert.Equal(InteriorCellPath, refused.File?.SourceRelativePath);
        Assert.Contains("a child it embeds has an 'EditorID' that is not a string", refused.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void RecordFromText_OfARecordWithADocumentOfItsOwn_WhoseEditorIdIsNoString_RefusesNamingItsFileAndTheField()
    {
        var text = File.ReadAllText(FullPath(QuestPath)).Replace("\"EditorID\": \"Quest\"", "\"EditorID\": 5", StringComparison.Ordinal);

        var refused = Assert.IsType<SourceFailure.Unreadable>(Repository.RecordFromText(Plugin, _quest.FormKey.ToString(), text).Stopped());

        Assert.Contains(QuestPath, refused.Reason, StringComparison.Ordinal);
        Assert.Contains("its 'EditorID' is not a string", refused.Reason, StringComparison.Ordinal);
    }

    private string InteriorCellWithItsRefsTyped(string type) =>
        File.ReadAllText(FullPath(InteriorCellPath)).Replace("\"PlacedObject\"", $"\"{type}\"", StringComparison.Ordinal);

    private void AssertNamesTheInteriorCellsUntypedRef(string type, SourceFailure.Unreadable refused)
    {
        Assert.Equal(
            (InteriorCellPath, _temporaryRef.FormKey.ToString()), (refused.File?.SourceRelativePath, refused.File?.FormKey));
        Assert.Contains($"a '{type}', and its slot holds no record type of that name", refused.Reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("PlacedObjekt", Read.GetByFormKey)]
    [InlineData("Npc", Read.GetByFormKey)]
    [InlineData("PlacedObjekt", Read.RecordFromText)]
    public void AChildNoTypeResolves_RefusesNamingItsOwnersFileAndWhy(string type, Read read)
    {
        File.WriteAllText(FullPath(InteriorCellPath), InteriorCellWithItsRefsTyped(type));

        AssertNamesTheInteriorCellsUntypedRef(type, Assert.IsType<SourceFailure.Unreadable>(Stopped(read, _temporaryRef, "refr", InteriorCellPath)));
    }

    [Fact]
    public void RecordFromText_OfAChildWhoseOwnersTextDeclaresNoFormKey_RefusesNamingItsOwnersFileAndWhat_ItDeclares()
    {
        var text = File.ReadAllText(FullPath(InteriorCellPath))
            .Replace($"\"FormKey\": \"{_interiorCell.FormKey}\"", "\"FormKey\": \"NotAFormKey\"", StringComparison.Ordinal);
        Assert.Contains("NotAFormKey", text, StringComparison.Ordinal);

        var refused = Assert.IsType<SourceFailure.Unreadable>(Repository.RecordFromText(Plugin, _temporaryRef.FormKey.ToString(), text).Stopped());

        Assert.Equal($"The text given for {InteriorCellPath} declares NotAFormKey, which is no FormKey.", refused.Reason);
    }

    private void SpellTheTemporaryRefAs(string spelled) =>
        File.WriteAllText(
            FullPath(InteriorCellPath),
            File.ReadAllText(FullPath(InteriorCellPath)).Replace(_temporaryRef.FormKey.ToString(), spelled, StringComparison.Ordinal));

    [Fact]
    public void AChildDelimitingItsFormKeyWithAnUnderscore_IsTheRecordTheCanonicalKeyNames()
    {
        SpellTheTemporaryRefAs(_temporaryRef.FormKey.ToString().Replace(':', '_'));

        var found = Repository.RecordByFormKey(Plugin, _temporaryRef.FormKey.ToString()).Value();

        Assert.Equal(_temporaryRef.FormKey.ToString(), found?.FormKey);
    }

    [Fact]
    public void AChildSpellingThePluginInAnotherCase_IsTheRecordTheKeyNames()
    {
        SpellTheTemporaryRefAs(_temporaryRef.FormKey.ToString().ToLowerInvariant());

        Assert.NotNull(Repository.RecordByFormKey(Plugin, _temporaryRef.FormKey.ToString()).Value());
    }

    [Fact]
    public void ReadingTheTree_RefusesAChildDeclaringNoFormKey_NamingItsOwnersFileAndWhat_ItDeclares()
    {
        SpellTheTemporaryRefAs("NotAFormKey");

        var refused = Assert.IsType<SourceFailure.Unreadable>(Stopped(Read.ReadingTheTree, _temporaryRef, "refr", InteriorCellPath));

        Assert.Equal(InteriorCellPath, refused.File?.SourceRelativePath);
        Assert.Contains("declares NotAFormKey, which is no FormKey", refused.Reason, StringComparison.Ordinal);
    }

    private string TopCellFormKey => _worldspace.TopCell.Require().FormKey.ToString();

    private void TypeTheTopCell(string type)
    {
        var path = FullPath(WorldspacePath);
        var text = File.ReadAllText(path);
        var typed = text.Replace("\"TopCell\": {", $"\"TopCell\": {{\n    \"MutagenObjectType\": \"{type}\",", StringComparison.Ordinal);
        Assert.NotEqual(text, typed);
        File.WriteAllText(path, typed);
    }

    private void AssertNamesTheWorldspacesTopCellTyped(string type, SourceFailure.Unreadable refused)
    {
        Assert.Equal((WorldspacePath, TopCellFormKey), (refused.File?.SourceRelativePath, refused.File?.FormKey));
        Assert.Contains($"its 'TopCell' names '{TopCellFormKey}' a '{type}', and its slot holds no record type of that name", refused.Reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("Cel", Read.GetByFormKey)]
    [InlineData("Npc", Read.GetByFormKey)]
    [InlineData("Cel", Read.ReadingTheTree)]
    [InlineData("Npc", Read.ReadingTheTree)]
    public void AChildInASingleTypeSlotTypedAsNothingTheSlotHolds_RefusesNamingItsOwnersFileAndWhy(string type, Read read)
    {
        TypeTheTopCell(type);

        AssertNamesTheWorldspacesTopCellTyped(
            type, Assert.IsType<SourceFailure.Unreadable>(Stopped(read, _worldspace.TopCell.Require(), "cell", WorldspacePath)));
    }

    private void HoldTheTemporaryRefTwiceInItsCell()
    {
        _interiorCell.Temporary.Add(_temporaryRef);
        File.WriteAllBytes(FullPath(InteriorCellPath), Serialize(_interiorCell));
    }

    private void AssertClaimedTwiceByTheInteriorCell(SourceFailure.Ambiguous refused)
    {
        Assert.Equal(new ClaimedFormKey(_temporaryRef.FormKey.ToString(), [InteriorCellPath]), refused.Claim);
        Assert.StartsWith($"'{InteriorCellPath}' holds {_temporaryRef.FormKey} more than once.", refused.Reason, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(Read.Get)]
    [InlineData(Read.ReadingTheTree)]
    public void AChildItsOwnersDocumentHoldsTwice_IsRefusedAsAClaimOfThatDocument(Read read)
    {
        HoldTheTemporaryRefTwiceInItsCell();

        AssertClaimedTwiceByTheInteriorCell(Assert.IsType<SourceFailure.Ambiguous>(Stopped(read, _temporaryRef, "refr", InteriorCellPath)));
    }

    private void GiveTheTemporaryRefItsCellsOwnFormKey()
    {
        var path = FullPath(InteriorCellPath);
        File.WriteAllText(
            path, File.ReadAllText(path).Replace(_temporaryRef.FormKey.ToString(), _interiorCell.FormKey.ToString(), StringComparison.Ordinal));
    }

    private void AssertTheCellClaimedTwiceByItsOwnDocument(SourceFailure.Ambiguous refused) =>
        Assert.Equal(new ClaimedFormKey(_interiorCell.FormKey.ToString(), [InteriorCellPath]), refused.Claim);

    [Theory]
    [InlineData(Read.Get)]
    [InlineData(Read.GetByFormKey)]
    [InlineData(Read.RecordFromText)]
    public void AContainerOneOfWhoseChildrenCarriesItsFormKey_IsRefusedAsAClaimOfThatDocument(Read read)
    {
        GiveTheTemporaryRefItsCellsOwnFormKey();

        AssertTheCellClaimedTwiceByItsOwnDocument(Assert.IsType<SourceFailure.Ambiguous>(Stopped(read, _interiorCell, "cell", InteriorCellPath)));
    }

    [Fact]
    public void ContainerOf_AChildWhoseOwnerAnotherChildCarriesTheFormKeyOf_IsRefusedAsAClaimOfThatDocument()
    {
        GiveTheTemporaryRefItsCellsOwnFormKey();

        AssertTheCellClaimedTwiceByItsOwnDocument(Assert.IsType<SourceFailure.Ambiguous>(Repository.ContainerOf(Plugin, Identity(_persistentRef, "refr")).Stopped()));
    }

    [Fact]
    public void Get_OfAFlatRecordOneOfWhoseChildrenCarriesItsFormKey_IsRefusedAsAClaimOfThatDocument()
    {
        var path = FullPath(QuestPath);
        File.WriteAllText(path, File.ReadAllText(path).Replace(_topic.FormKey.ToString(), _quest.FormKey.ToString(), StringComparison.Ordinal));

        Assert.Equal(
            new ClaimedFormKey(_quest.FormKey.ToString(), [QuestPath]),
            Assert.IsType<SourceFailure.Ambiguous>(Repository.RecordOf(Plugin, Identity(_quest, "qust")).Stopped()).Claim);
    }

    [Fact]
    public void ContainerOf_APlacedReferenceInsideItsCell_NamesTheCellAndTheSlot()
    {
        var container = Repository.ContainerOf(Plugin, Identity(_persistentRef, "refr")).Value();

        Assert.Equal(_interiorCell.FormKey.ToString(), container?.ParentFormKey);
        Assert.Equal("Persistent", container?.SlotName);
    }

    [Fact]
    public void ContainerOf_ATopicInsideItsQuest_NamesTheQuestAndTheSlot()
    {
        var container = Repository.ContainerOf(Plugin, Identity(_topic, "dial")).Value();

        Assert.Equal(_quest.FormKey.ToString(), container?.ParentFormKey);
        Assert.Equal("DialogTopics", container?.SlotName);
    }

    private void GiveTheInteriorCellsDocumentNoFormKey()
    {
        var path = FullPath(InteriorCellPath);
        File.WriteAllText(path, File.ReadAllText(path).Replace(_interiorCell.FormKey.ToString(), "NotAFormKey", StringComparison.Ordinal));
    }

    [Fact]
    public void ContainerOf_AChildWhoseOwnerDocumentNamesNoRecord_RefusesWithTheReadersWords()
    {
        GiveTheInteriorCellsDocumentNoFormKey();

        var refused = Assert.IsType<SourceFailure.Unreadable>(Repository.ContainerOf(Plugin, Identity(_temporaryRef, "refr")).Stopped());

        Assert.Contains("names no document of its own", refused.Reason, StringComparison.Ordinal);
    }

    private const string FreeFormKey = "000F00:Embedded.esp";

    private static (IReadOnlyList<string> Gone, IReadOnlyList<string> Appeared) Difference(
        IReadOnlyList<string> before, IReadOnlyList<string> after) =>
        ([.. before.Except(after)], [.. after.Except(before)]);

    private void Rekey(RecordIdentity identity) =>
        Repository.SaveChanges(Repository.ChangesToRekey(Plugin, identity, FreeFormKey)).Wrote();

    [Fact]
    public void Rekey_AnEmbeddedChild_RewritesOnlyTheOwnersDocument()
    {
        var before = TreeSnapshot.Of(_modFolder);

        Rekey(Identity(_temporaryRef, "refr"));

        var (gone, appeared) = Difference(before, TreeSnapshot.Of(_modFolder));
        Assert.Single(gone);
        Assert.Single(appeared);
        Assert.StartsWith($"file {InteriorCellPath.Replace('\\', '/')} ", gone[0], StringComparison.Ordinal);
        Assert.StartsWith($"file {InteriorCellPath.Replace('\\', '/')} ", appeared[0], StringComparison.Ordinal);
        Assert.NotNull(Repository.RecordByFormKey(Plugin, FreeFormKey).Value());
        Assert.Null(Repository.RecordByFormKey(Plugin, _temporaryRef.FormKey.ToString()).Value());
    }

    [Fact]
    public void Rekey_AContainer_MovesItsChildRecordsFilesUnderTheNewKey()
    {
        Rekey(Identity(_worldspace, "wrld"));

        var child = Repository.RelativePathOf(Plugin, Identity(_exteriorCell, "cell")).Value();
        Assert.Contains("000F00_Embedded.esp", child, StringComparison.Ordinal);
        Assert.Null(Repository.RelativePathOf(Plugin, Identity(_worldspace, "wrld")).Value());
    }

    [Fact]
    public void Rekey_ARecordWithAFileOfItsOwn_ReplacesThatFileUnderTheNewKey()
    {
        var before = TreeSnapshot.Of(_modFolder);

        Rekey(Identity(_quest, "qust"));

        var (gone, appeared) = Difference(before, TreeSnapshot.Of(_modFolder));
        Assert.Single(gone);
        Assert.Single(appeared);
        Assert.Contains("Quests/", gone[0], StringComparison.Ordinal);
        Assert.Contains("000F00_Embedded.esp.json", appeared[0], StringComparison.Ordinal);
    }

    [Fact]
    public void ChangingTheFormKeyOfARecordNoDocumentCarries_IsRefusedNamingIt()
    {
        var absent = new SourceDocument("00FFFF:Embedded.esp", "refr", "Absent", "{}");

        var refused = Assert.IsType<SourceFailure.NotCarried>(Repository.ChangesToRekey(Plugin, absent.Identity, FreeFormKey).Stopped());

        Assert.Contains("00FFFF:Embedded.esp", refused.Reason, StringComparison.Ordinal);
    }

    public enum Change
    {
        Rewrite,
        Rekey,
    }

    [Theory]
    [InlineData(Change.Rewrite)]
    [InlineData(Change.Rekey)]
    public void AChildItsOwnersTextNamesWhereItsTypeHoldsNone_IsRefusedAsNoDocumentHoldingIt(Change change)
    {
        var child = WriteAChildInASlotItsOwnerTypeHoldsNone();

        AssertRefusedAsAChildItsOwnersTextDoesNotCarry(Assert.IsType<SourceFailure.NotCarried>(ChangesTo(change, child).Stopped()));
    }

    private Answer<SourceChanges, SourceFailure> ChangesTo(Change change, SourceDocument child) =>
        change switch
        {
            Change.Rewrite => Repository.ChangesToRewrite(Plugin, child),
            Change.Rekey => Repository.ChangesToRekey(Plugin, child.Identity, FreeFormKey),
            _ => throw new ArgumentOutOfRangeException(nameof(change), change, null),
        };

    [Fact]
    public void ChangesToRekey_OfARecordWhoseFileWentAfterItWasLocated_RefusesAsNoDocumentHoldingIt()
    {
        var quest = Identity(_quest, "qust");
        File.Delete(FullPath(Repository.RelativePathOf(Plugin, quest).Value().Require()));

        var refused = Assert.IsType<SourceFailure.NotCarried>(Repository.ChangesToRekey(Plugin, quest, FreeFormKey).Stopped());

        Assert.Contains(_quest.FormKey.ToString(), refused.Reason, StringComparison.Ordinal);
    }

    private SourceDocument WriteAChildInASlotItsOwnerTypeHoldsNone()
    {
        var folder = RecordTypes.For(Release).GroupOf("globalfloat").Require();
        var carrier = Path.Combine(_modFolder, Root, folder, $"Carrier - 00A000_{PluginName}.json");
        Directory.CreateDirectory(Path.GetDirectoryName(carrier).Require());
        File.WriteAllText(
            carrier,
            "{\n  \"MutagenObjectType\": \"GlobalFloat\",\n  \"FormKey\": \"00A000:Embedded.esp\",\n" +
            "  \"Temporary\": [ { \"FormKey\": \"00A001:Embedded.esp\" } ]\n}");
        return new SourceDocument("00A001:Embedded.esp", "refr", null, "{\n  \"FormKey\": \"00A001:Embedded.esp\"\n}");
    }

    private static void AssertRefusedAsAChildItsOwnersTextDoesNotCarry(SourceFailure.NotCarried refused)
    {
        Assert.Contains("its own text does not carry it", refused.Reason, StringComparison.Ordinal);
        Assert.EndsWith(
            "If nothing outside Modbench changed that file, this is a defect — please report it; otherwise relaunch mEdit so the record index re-reads the tree.",
            refused.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void ContainerOf_ARecordWithADocumentOfItsOwn_IsNull()
    {
        Assert.Null(Repository.ContainerOf(Plugin, Identity(_quest, "qust")).Value());
    }

    [Fact]
    public void Get_OfARecordNoDocumentCarries_IsNull()
    {
        Assert.Null(Repository.RecordOf(Plugin, new RecordIdentity("00FFFF:Embedded.esp", "refr", "Absent")).Value());
    }

    [Fact]
    public void Get_AfterAHandEditMovedAChildToAnotherOwner_FindsItAtTheNewOwner_NotFromTheMapBuiltBeforeTheMove()
    {
        var repository = Repository;
        Assert.NotNull(repository.RecordOf(Plugin, Identity(_temporaryRef, "refr")).Value());

        MoveTemporaryRef(_interiorCell, _exteriorCell);

        var found = repository.RecordOf(Plugin, Identity(_temporaryRef, "refr")).Value();
        Assert.NotNull(found);
        Assert.Equal(_temporaryRef.FormKey.ToString(), RootFormKeyWhichTellsAChildsOwnTextFromItsOwnersDocument(found.Body));
        Assert.Equal(
            Path.GetRelativePath(_modFolder, FullPath(ExteriorCellPath)),
            repository.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")).Value());
    }

    [Fact]
    public void RelativePathOf_AChildMovedTwiceWithinOneOperation_IsAbsentNeverTheOwnerThatLostIt()
    {
        var repository = Repository;
        Assert.NotNull(repository.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")).Value());
        MoveTemporaryRef(_interiorCell, _exteriorCell);
        Assert.NotNull(repository.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")).Value());

        MoveTemporaryRef(_exteriorCell, _interiorCell);

        Assert.Null(repository.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")).Value());
    }

    [Fact]
    public void RelativePathOf_ForAChildInsideADocumentOfAPathAmbiguousGroup_FindsThatDocument_ThoughGlobalsMapsToFourTypesSoOnlyTheDocumentNamesItsOwn()
    {
        var folder = RecordTypes.For(Release).GroupOf("globalfloat")
            ?? throw new InvalidOperationException("Expected 'globalfloat' to resolve to a group folder.");
        var carrier = Path.Combine(_modFolder, Root, folder, "Carrier - 00A000_Embedded.esp.json");
        Directory.CreateDirectory(Path.GetDirectoryName(carrier) ?? throw new InvalidOperationException($"Expected '{carrier}' to have a parent directory."));
        File.WriteAllText(
            carrier,
            "{\n  \"MutagenObjectType\": \"GlobalFloat\",\n  \"FormKey\": \"00A000:Embedded.esp\",\n" +
            "  \"Temporary\": [ { \"FormKey\": \"00A001:Embedded.esp\" } ]\n}");

        var child = new RecordIdentity("00A001:Embedded.esp", "refr", null);

        Assert.Equal(Path.GetRelativePath(_modFolder, carrier), Repository.RelativePathOf(Plugin, child).Value());
    }

    [Fact]
    public void ChangesToRemove_OfAnEmbeddedChild_RewritesItsOwnersDocument_AndWritesNothing()
    {
        var before = File.ReadAllText(FullPath(QuestPath));

        var changes = Repository.ChangesToRemove(Plugin, Identity(_response, "info")).Value();

        var owner = Assert.Single(changes.Documents);
        Assert.Equal(FullPath(QuestPath), Path.Combine(_modFolder, owner.Path));
        Assert.DoesNotContain("\"Response\"", owner.Text, StringComparison.Ordinal);
        Assert.Contains("\"Response2\"", owner.Text, StringComparison.Ordinal);
        Assert.Empty(changes.Deletions);
        Assert.Equal(before, File.ReadAllText(FullPath(QuestPath)));
    }

    private static SourceDocument ANewChild(IMajorRecordGetter record, string recordType) =>
        new(record.FormKey.ToString(), recordType, record.EditorID, RecordTextCodec.SerializeToText(record, Release));

    [Fact]
    public void ChangesToPutChild_IntoAnEmbeddedContainersSlot_AppendsToItInItsOwnersDocument_AndWritesNothing()
    {
        var before = File.ReadAllText(FullPath(QuestPath));
        var added = new DialogResponses(_mod) { EditorID = "Response3" };

        var changes = Repository.ChangesToPutChild(Plugin, Identity(_topic, "dial"), "Responses", ANewChild(added, "info")).Value();

        var owner = Assert.Single(changes.Documents);
        Assert.Equal(FullPath(QuestPath), Path.Combine(_modFolder, owner.Path));
        Assert.Contains("\"Response3\"", owner.Text, StringComparison.Ordinal);
        Assert.Empty(changes.Deletions);
        Assert.Equal(before, File.ReadAllText(FullPath(QuestPath)));
    }

    [Fact]
    public void ChangesToPutChild_IntoAnEmbeddedContainerWhoseOwnersDocumentAnotherToolRenamed_AppendsToTheRenamedDocument()
    {
        var renamed = Path.Combine(Root, "Quests", "Renamed by hand.json");
        File.Move(FullPath(QuestPath), FullPath(renamed));
        var added = new DialogResponses(_mod) { EditorID = "Response3" };

        var changes = Repository.ChangesToPutChild(Plugin, Identity(_topic, "dial"), "Responses", ANewChild(added, "info")).Value();

        var owner = Assert.Single(changes.Documents);
        Assert.Equal(renamed, owner.Path);
        Assert.Contains("\"Response3\"", owner.Text, StringComparison.Ordinal);
    }

    [Fact]
    public void ChangesToPutChild_IntoAContainerWithADocumentOfItsOwn_AppendsToThatDocument()
    {
        var added = new PlacedObject(_mod) { EditorID = "AddedRef", Position = new P3Float(1f, 1f, 1f), Scale = 1f };

        var changes = Repository.ChangesToPutChild(Plugin, Identity(_interiorCell, "cell"), "Temporary", ANewChild(added, "refr")).Value();

        var document = Assert.Single(changes.Documents);
        Assert.Equal(FullPath(InteriorCellPath), Path.Combine(_modFolder, document.Path));
        Assert.Contains("\"AddedRef\"", document.Text, StringComparison.Ordinal);
    }

    [Fact]
    public void ChangesToPutChild_IntoASingleSlotThatHoldsARecord_IsSlotHeld()
    {
        var other = new Cell(_mod) { EditorID = "OtherTopCell" };

        var stopped = Repository.ChangesToPutChild(Plugin, Identity(_worldspace, "wrld"), "TopCell", ANewChild(other, "cell")).Stopped();

        Assert.IsType<SourceFailure.SlotHeld>(stopped);
    }

    [Fact]
    public void ChangesToPutChild_IntoASlotItsContainersTextNamesTwice_IsUnreadable()
    {
        var text = File.ReadAllText(FullPath(InteriorCellPath));
        File.WriteAllText(FullPath(InteriorCellPath), text.Replace("\"Temporary\": [", "\"Temporary\": [],\n  \"Temporary\": [", StringComparison.Ordinal));
        var added = new PlacedObject(_mod) { EditorID = "AddedRef", Position = new P3Float(1f, 1f, 1f), Scale = 1f };

        var stopped = Repository.ChangesToPutChild(Plugin, Identity(_interiorCell, "cell"), "Temporary", ANewChild(added, "refr")).Stopped();

        Assert.IsType<SourceFailure.Unreadable>(stopped);
    }

    [Fact]
    public void ChangesToPutChild_IntoAContainerNoDocumentHolds_IsNotCarried()
    {
        var added = new DialogResponses(_mod) { EditorID = "Response3" };

        var stopped = Repository.ChangesToPutChild(
            Plugin, new RecordIdentity("00FFFF:Embedded.esp", "dial", "Absent"), "Responses", ANewChild(added, "info")).Stopped();

        Assert.IsType<SourceFailure.NotCarried>(stopped);
    }

    [Fact]
    public void ChangesToRemove_OfAContainerWithADirectoryOfItsOwn_DeletesTheWholeDirectory_AndRemovesNothing()
    {
        var directory = Path.GetDirectoryName(FullPath(ExteriorCellPath)).Require();

        var changes = Repository.ChangesToRemove(Plugin, Identity(_exteriorCell, "cell")).Value();

        Assert.Equal([Path.GetRelativePath(_modFolder, directory)], changes.Deletions);
        Assert.Empty(changes.Documents);
        Assert.True(Directory.Exists(directory));
    }

    [Fact]
    public void Remove_OfARecordNoDocumentHolds_SaysNoDocumentHoldsIt()
    {
        var refused = Assert.IsType<SourceFailure.NotCarried>(
            Repository.Remove(Plugin, new RecordIdentity("00FFFF:Embedded.esp", "refr", "Absent")).Failed());

        Assert.StartsWith("No document in Embedded.esp's tree holds 00FFFF:Embedded.esp.", refused.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void RelativePathOf_ForAKeyADocumentNamesOutsideEveryEmbedSlot_FindsNoOwner_ForAFormKeyAnywhereElseIsAReferenceNotAChild()
    {
        var quest = File.ReadAllText(FullPath(QuestPath));
        File.WriteAllText(
            FullPath(QuestPath),
            quest.TrimEnd().TrimEnd('}') + ",\n  \"NotAChild\": { \"FormKey\": \"00A001:Embedded.esp\" }\n}");

        var identity = new RecordIdentity("00A001:Embedded.esp", "refr", "Absent");

        Assert.Null(Repository.RelativePathOf(Plugin, identity).Value());
        Assert.StartsWith(
            "No document in Embedded.esp's tree holds 00A001:Embedded.esp.", Repository.Remove(Plugin, identity).Failed().Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void Remove_OfAKeyASlotNamesButTheRecordDoesNotCarry_SaysTheOwnersTextLacksIt_ForOnlyTheCodecsObjectModelCanSayTheRecordHasNoSuchMember()
    {
        var quest = File.ReadAllText(FullPath(QuestPath));
        File.WriteAllText(
            FullPath(QuestPath),
            quest.TrimEnd().TrimEnd('}') + ",\n  \"Persistent\": [ { \"FormKey\": \"00A001:Embedded.esp\" } ]\n}");

        var refused = Assert.IsType<SourceFailure.NotCarried>(
            Repository.Remove(Plugin, new RecordIdentity("00A001:Embedded.esp", "refr", "Absent")).Failed());

        Assert.StartsWith($"{QuestPath} was found holding 00A001:Embedded.esp, but its own text does not carry it.", refused.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void FormKeysUsed_IncludesEveryEmbeddedChildsFormKey_InThreeDifferentOwnersSlots()
    {
        var held = Repository.FormKeysUsed(Plugin).Value();

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
        Assert.NotNull(Repository.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")).Value());

        MoveTemporaryRef(_interiorCell, _exteriorCell);

        Assert.Equal(
            Path.GetRelativePath(_modFolder, FullPath(ExteriorCellPath)),
            Repository.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")).Value());
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
        var path = FullPath(PluginSourceRoot.ContainerDocument(Path.Combine(Root, "Cells", "0", "0", Leaf(cell))));
        Directory.CreateDirectory(Path.GetDirectoryName(path) ?? throw new InvalidOperationException($"Expected '{path}' to have a parent directory."));
        File.WriteAllBytes(path, Serialize(cell));

        Assert.Equal(
            new RecordIdentity(added.FormKey.ToString(), "refr", "AddedRef"),
            TheNextOperation.RecordByFormKey(Plugin, added.FormKey.ToString()).Value()?.Identity);
    }

    [Fact]
    public void RelativePathOf_OfAChildWhoseOwnerAnotherToolRenamedBetweenTwoOperations_IsTheRenamedDocument()
    {
        Assert.NotNull(Repository.RelativePathOf(Plugin, Identity(_response, "info")).Value());

        var renamed = Path.Combine(Root, "Quests", "Renamed by hand.json");
        File.Move(FullPath(QuestPath), FullPath(renamed));

        Assert.Equal(renamed, Repository.RelativePathOf(Plugin, Identity(_response, "info")).Value());
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
        Assert.NotNull(Repository.RelativePathOf(Plugin, Identity(_persistentRef, "refr")).Value());

        var moved = Path.Combine(Root, "Cells", "1", "1", Leaf(_interiorCell));
        Directory.CreateDirectory(Path.GetDirectoryName(FullPath(moved)) ?? throw new InvalidOperationException($"Expected '{moved}' to have a parent directory."));
        Directory.Move(Path.GetDirectoryName(FullPath(InteriorCellPath)) ?? throw new InvalidOperationException("Expected the interior cell's document to sit in its own directory."), FullPath(moved));

        Assert.Equal(
            PluginSourceRoot.ContainerDocument(moved),
            Repository.RelativePathOf(Plugin, Identity(_persistentRef, "refr")).Value());
    }

    [Fact]
    public void RelativePathOf_OfAChildAnotherToolCopiedIntoASecondOwnerBetweenTwoOperations_IsRefusedAsAmbiguous()
    {
        Assert.NotNull(Repository.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")).Value());

        _exteriorCell.Temporary.Add(_temporaryRef);
        File.WriteAllBytes(FullPath(ExteriorCellPath), Serialize(_exteriorCell));

        Assert.IsType<SourceFailure.Ambiguous>(TheNextOperation.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")).Stopped());
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
            Repository.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")).Value());
    }

    [Fact]
    public void Get_EveryEmbeddedChildAskedInOneOperation_NamesEachOne()
    {
        var repository = Repository;
        IMajorRecordGetter[] children = [_persistentRef, _temporaryRef, _topCellRef, _exteriorRef, _topic, _response, _response2];

        var named = children.Select(child => repository.RecordByFormKey(Plugin, child.FormKey.ToString()).Value()?.EditorId);

        Assert.Equal(children.Select(child => child.EditorID), named);
    }
}

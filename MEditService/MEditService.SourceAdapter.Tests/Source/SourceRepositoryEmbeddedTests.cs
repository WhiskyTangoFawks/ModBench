using System.Text;
using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
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
            _modFolder, TheDocumentsTheWholeModDoorWritesForThisGraph());
    }

    public void Dispose() => _modFolder.Dispose();

    private TreeFile[] TheDocumentsTheWholeModDoorWritesForThisGraph() =>
    [
        new(InteriorCellPath, Serialize(_interiorCell)),
        new(WorldspacePath, Serialize(_worldspace)),
        new(ExteriorCellPath, Serialize(_exteriorCell)),
        new(QuestPath, Serialize(_quest)),
        new(TopicPath, Serialize(_topic)),
        new(ResponsePath(_response), Serialize(_response)),
        new(ResponsePath(_response2), Serialize(_response2)),
    ];

    private static string Root => PluginSourceRoot.For(PluginName);

    private string InteriorCellPath =>
        PluginSourceRoot.ContainerDocument(Path.Combine(Root, "Cells", "0", "0", PluginSourceRoot.Leaf(_interiorCell)));

    private string WorldspacePath =>
        PluginSourceRoot.ContainerDocument(Path.Combine(Root, "Worldspaces", PluginSourceRoot.Leaf(_worldspace)));

    private string ExteriorCellPath =>
        PluginSourceRoot.ContainerDocument(Path.Combine(Root, "Worldspaces", PluginSourceRoot.Leaf(_worldspace), "0, 0", "0, 0", PluginSourceRoot.Leaf(_exteriorCell)));

    private string QuestDirectory => Path.Combine(Root, "Quests", PluginSourceRoot.Leaf(_quest));

    private string QuestPath => PluginSourceRoot.ContainerDocument(QuestDirectory);

    private string TopicDirectory => Path.Combine(QuestDirectory, "DialogTopics", PluginSourceRoot.Leaf(_topic));

    private string TopicPath => PluginSourceRoot.ContainerDocument(TopicDirectory);

    private string ResponsePath(DialogResponses response) => Path.Combine(TopicDirectory, "Responses", PluginSourceRoot.Leaf(response) + ".json");

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

    private static string? RootFormKeyWhichTellsAChildsOwnTextFromItsOwnersDocument(string body)
    {
        using var document = JsonDocument.Parse(body);
        return document.RootElement.TryGetProperty("FormKey", out var formKey) ? formKey.GetString() : null;
    }

    public enum Child
    {
        PersistentRef,
        TopCellRef,
    }

    private (IMajorRecordGetter Record, string RecordType) Embedded(Child child) =>
        child switch
        {
            Child.PersistentRef => (_persistentRef, "refr"),
            Child.TopCellRef => (_topCellRef, "refr"),
            _ => throw new ArgumentOutOfRangeException(nameof(child), child, null),
        };

    private static string? RootEditorId(string body)
    {
        using var document = JsonDocument.Parse(body);
        return document.RootElement.GetProperty("EditorID").GetString();
    }

    private static RecordIdentity? IdentityIn(ISourceRepository operation, IMajorRecordGetter record) =>
        operation.RecordByFormKey(Plugin, record.FormKey.ToString()).Value()?.Identity;

    [Theory]
    [InlineData(Child.PersistentRef)]
    [InlineData(Child.TopCellRef)]
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
        var topCell = Repository.RecordByFormKey(Plugin, _worldspace.TopCell.Require().FormKey.ToString()).Value()?.Body;

        Assert.Contains("\"TopCellRef\"", topCell, StringComparison.Ordinal);
    }

    public enum FiledChild
    {
        Topic,
        Response,
    }

    private (IMajorRecordGetter Record, string RecordType, string Path, string Removed) Filed(FiledChild child) =>
        child switch
        {
            FiledChild.Topic => (_topic, "dial", TopicPath, TopicDirectory),
            FiledChild.Response => (_response, "info", ResponsePath(_response), ResponsePath(_response)),
            _ => throw new ArgumentOutOfRangeException(nameof(child), child, null),
        };

    [Theory]
    [InlineData(FiledChild.Topic)]
    [InlineData(FiledChild.Response)]
    public void AQuestsTopicAndATopicsResponse_AreEachTheTextOfAFileOfItsOwn_InTheirContainersDirectory(FiledChild child)
    {
        var (record, recordType, path, _) = Filed(child);

        var document = Repository.RecordByFormKey(Plugin, record.FormKey.ToString()).Value().Require();

        Assert.Equal((Identity(record, recordType), File.ReadAllText(FullPath(path))), (document.Identity, document.Body));
        Assert.Equal(path, Repository.RelativePathOf(Plugin, Identity(record, recordType)).Value());
    }

    [Fact]
    public void AKeyNothingCarries_IsNoRecord()
    {
        Assert.Null(Repository.RecordByFormKey(Plugin, "00FFFF:Embedded.esp").Value());
    }

    [Fact]
    public void AKeyWhoseDocumentIsNoRecordDocument_IsRefusedWithTheReadersWords()
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

    [Fact]
    public void ARecordsEditorIdThatIsNoString_RefusesNamingItsFileAndTheField()
    {
        GiveANumberForTheEditorId(QuestPath, "Quest");

        var refused = Assert.IsType<SourceFailure.Unreadable>(Repository.RecordByFormKey(Plugin, _quest.FormKey.ToString()).Stopped());

        Assert.Equal((QuestPath, _quest.FormKey.ToString()), (refused.File?.SourceRelativePath, refused.File?.FormKey));
        Assert.Contains("its 'EditorID' is not a string", refused.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void AChildWhoseEditorIdIsNoString_RefusesNamingItsOwnersFileTheChildAndTheField()
    {
        GiveANumberForTheEditorId(InteriorCellPath, "TempRef");

        var refused = Assert.IsType<SourceFailure.Unreadable>(Repository.RecordByFormKey(Plugin, _temporaryRef.FormKey.ToString()).Stopped());

        Assert.Equal((InteriorCellPath, _temporaryRef.FormKey.ToString()), (refused.File?.SourceRelativePath, refused.File?.FormKey));
        Assert.Contains($"its 'Temporary' names '{_temporaryRef.FormKey}', whose 'EditorID' is not a string", refused.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void TheEditorIdsHeld_WhenAnEmbeddedChildsEditorIdIsNoString_AreRefusedNamingItsOwnersFileAndTheField()
    {
        GiveANumberForTheEditorId(InteriorCellPath, "TempRef");

        var refused = Assert.IsType<SourceFailure.Unreadable>(Repository.EditorIdsHeld(Plugin).Stopped());

        Assert.Equal(InteriorCellPath, refused.File?.SourceRelativePath);
        Assert.Contains("a child it embeds has an 'EditorID' that is not a string", refused.Reason, StringComparison.Ordinal);
    }

    private void TypeTheInteriorCellsRefsAs(string type) =>
        File.WriteAllText(
            FullPath(InteriorCellPath),
            File.ReadAllText(FullPath(InteriorCellPath)).Replace("\"PlacedObject\"", $"\"{type}\"", StringComparison.Ordinal));

    [Fact]
    public void AChildNoTypeResolves_RefusesNamingItsOwnersFileAndWhy()
    {
        TypeTheInteriorCellsRefsAs("PlacedObjekt");

        var refused = Assert.IsType<SourceFailure.Unreadable>(Repository.RecordByFormKey(Plugin, _temporaryRef.FormKey.ToString()).Stopped());

        Assert.Equal((InteriorCellPath, _temporaryRef.FormKey.ToString()), (refused.File?.SourceRelativePath, refused.File?.FormKey));
        Assert.Contains("a 'PlacedObjekt', and its slot holds no record type of that name", refused.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void TheTextGivenForAChildsOwner_DeclaringNoFormKey_IsRefusedNamingTheOwnersFileAndWhatItDeclares()
    {
        var text = File.ReadAllText(FullPath(InteriorCellPath))
            .Replace($"\"FormKey\": \"{_interiorCell.FormKey}\"", "\"FormKey\": \"NotAFormKey\"", StringComparison.Ordinal);
        Assert.Contains("NotAFormKey", text, StringComparison.Ordinal);

        var refused = Assert.IsType<SourceFailure.Unreadable>(Repository.RecordFromText(Plugin, _temporaryRef.FormKey.ToString(), text).Stopped());

        Assert.Equal($"The text given for {InteriorCellPath} declares NotAFormKey, which is no FormKey.", refused.Reason);
    }

    private SourceFailure ReadingTheTree() => Repository.ReadDocuments(Plugin, tree => tree.Records.ToList()).Stopped();

    [Fact]
    public void AChildNoTypeResolves_RefusesTheTreesRead_NamingItsOwnersFileAndTheFirstSuchChild()
    {
        TypeTheInteriorCellsRefsAs("PlacedObjekt");

        var refused = Assert.IsType<SourceFailure.Unreadable>(ReadingTheTree());

        Assert.Equal((InteriorCellPath, _persistentRef.FormKey.ToString()), (refused.File?.SourceRelativePath, refused.File?.FormKey));
        Assert.Contains("a 'PlacedObjekt', and its slot holds no record type of that name", refused.Reason, StringComparison.Ordinal);
    }

    private void SpellTheTemporaryRefAs(string spelled) =>
        File.WriteAllText(
            FullPath(InteriorCellPath),
            File.ReadAllText(FullPath(InteriorCellPath)).Replace(_temporaryRef.FormKey.ToString(), spelled, StringComparison.Ordinal));

    public enum Spelling
    {
        DelimitedWithAnUnderscore,
        ThePluginInAnotherCase,
    }

    private string Spelled(Spelling spelling) =>
        spelling switch
        {
            Spelling.DelimitedWithAnUnderscore => _temporaryRef.FormKey.ToString().Replace(':', '_'),
            Spelling.ThePluginInAnotherCase => _temporaryRef.FormKey.ToString().ToLowerInvariant(),
            _ => throw new ArgumentOutOfRangeException(nameof(spelling), spelling, null),
        };

    [Theory]
    [InlineData(Spelling.DelimitedWithAnUnderscore)]
    [InlineData(Spelling.ThePluginInAnotherCase)]
    public void AChildSpellingItsFormKeyAnotherWay_IsTheRecordTheCanonicalKeyNames(Spelling spelling)
    {
        SpellTheTemporaryRefAs(Spelled(spelling));

        var found = Repository.RecordByFormKey(Plugin, _temporaryRef.FormKey.ToString()).Value();

        Assert.Equal(_temporaryRef.FormKey.ToString(), found?.FormKey, ignoreCase: true);
        Assert.Equal("TempRef", found?.EditorId);
    }

    [Fact]
    public void AChildDeclaringNoFormKey_RefusesTheTreesRead_NamingItsOwnersFileAndWhatItDeclares()
    {
        SpellTheTemporaryRefAs("NotAFormKey");

        var refused = Assert.IsType<SourceFailure.Unreadable>(ReadingTheTree());

        Assert.Equal(InteriorCellPath, refused.File?.SourceRelativePath);
        Assert.Contains("declares NotAFormKey, which is no FormKey", refused.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void AChildItsOwnersDocumentHoldsTwice_IsRefusedAsAClaimOfThatDocument()
    {
        _interiorCell.Temporary.Add(_temporaryRef);
        File.WriteAllBytes(FullPath(InteriorCellPath), Serialize(_interiorCell));

        var refused = Assert.IsType<SourceFailure.Ambiguous>(Repository.RecordOf(Plugin, Identity(_temporaryRef, "refr")).Stopped());

        Assert.Equal(new ClaimedFormKey(_temporaryRef.FormKey.ToString(), [InteriorCellPath]), refused.Claim);
        Assert.StartsWith($"'{InteriorCellPath}' holds {_temporaryRef.FormKey} more than once.", refused.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void AContainerOneOfWhoseChildrenCarriesItsFormKey_IsRefusedAsAClaimOfThatDocument()
    {
        var path = FullPath(InteriorCellPath);
        File.WriteAllText(
            path, File.ReadAllText(path).Replace(_temporaryRef.FormKey.ToString(), _interiorCell.FormKey.ToString(), StringComparison.Ordinal));

        var refused = Assert.IsType<SourceFailure.Ambiguous>(Repository.RecordOf(Plugin, Identity(_interiorCell, "cell")).Stopped());

        Assert.Equal(new ClaimedFormKey(_interiorCell.FormKey.ToString(), [InteriorCellPath]), refused.Claim);
    }

    public enum Contained
    {
        APlacedReferenceInItsCell,
        ATopCellInItsWorldspace,
        ATopicInItsQuest,
        AResponseInItsTopic,
        AQuestOfADocumentOfItsOwn,
    }

    private (RecordIdentity Child, DocumentContainment? Container) Containment(Contained contained) =>
        contained switch
        {
            Contained.APlacedReferenceInItsCell => (Identity(_persistentRef, "refr"), new DocumentContainment(_interiorCell.FormKey.ToString(), "cell", "Persistent")),
            Contained.ATopCellInItsWorldspace => (Identity(_worldspace.TopCell.Require(), "cell"), new DocumentContainment(_worldspace.FormKey.ToString(), "wrld", "TopCell")),
            Contained.ATopicInItsQuest => (Identity(_topic, "dial"), new DocumentContainment(_quest.FormKey.ToString(), "qust", "DialogTopics")),
            Contained.AResponseInItsTopic => (Identity(_response, "info"), new DocumentContainment(_topic.FormKey.ToString(), "dial", "Responses")),
            Contained.AQuestOfADocumentOfItsOwn => (Identity(_quest, "qust"), null),
            _ => throw new ArgumentOutOfRangeException(nameof(contained), contained, null),
        };

    [Theory]
    [InlineData(Contained.APlacedReferenceInItsCell)]
    [InlineData(Contained.ATopCellInItsWorldspace)]
    [InlineData(Contained.ATopicInItsQuest)]
    [InlineData(Contained.AResponseInItsTopic)]
    [InlineData(Contained.AQuestOfADocumentOfItsOwn)]
    public void ARecordsContainer_IsTheRecordCarryingItOrWhoseDirectoryHoldsItsSlotsFolder_AndTheSlotItSitsIn(Contained contained)
    {
        var (child, container) = Containment(contained);

        Assert.Equal(container, Repository.ContainerOf(Plugin, child).Value());
    }

    private void GiveTheInteriorCellsDocumentNoFormKey()
    {
        var path = FullPath(InteriorCellPath);
        File.WriteAllText(path, File.ReadAllText(path).Replace(_interiorCell.FormKey.ToString(), "NotAFormKey", StringComparison.Ordinal));
    }

    [Fact]
    public void TheContainerOfAChildWhoseOwnerDocumentNamesNoRecord_IsRefusedWithTheReadersWords()
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
    public void RekeyingAnEmbeddedChild_RewritesOnlyTheOwnersDocument()
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
    public void RekeyingAContainer_MovesItsChildRecordsFilesUnderTheNewKey()
    {
        Rekey(Identity(_worldspace, "wrld"));

        var child = Repository.RelativePathOf(Plugin, Identity(_exteriorCell, "cell")).Value();
        Assert.Contains("000F00_Embedded.esp", child, StringComparison.Ordinal);
        Assert.Null(Repository.RelativePathOf(Plugin, Identity(_worldspace, "wrld")).Value());
    }

    [Fact]
    public void RekeyingAContainerOntoADirectoryThatIsThere_IsRefusedAsHavingNowhereToMoveTo()
    {
        var directory = Path.GetDirectoryName(FullPath(Repository.RelativePathOf(Plugin, Identity(_worldspace, "wrld")).Value().Require())).Require();
        Directory.CreateDirectory(directory.Replace(_worldspace.FormKey.ToString().Replace(':', '_'), FreeFormKey.Replace(':', '_'), StringComparison.Ordinal));

        var refused = Assert.IsType<SourceFailure.Inaccessible>(Repository.ChangesToRekey(Plugin, Identity(_worldspace, "wrld"), FreeFormKey).Stopped());

        Assert.Contains("nowhere to move to", refused.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void RekeyingARecordWithAFileOfItsOwnInItsContainersDirectory_ReplacesThatFileThereUnderTheNewKey()
    {
        var before = TreeSnapshot.Of(_modFolder);

        Rekey(Identity(_response, "info"));

        var (gone, appeared) = Difference(before, TreeSnapshot.Of(_modFolder));
        var responses = Path.Combine(TopicDirectory, "Responses").Replace('\\', '/');
        Assert.StartsWith($"file {ResponsePath(_response).Replace('\\', '/')} ", Assert.Single(gone), StringComparison.Ordinal);
        Assert.StartsWith($"file {responses}/Response - 000F00_Embedded.esp.json ", Assert.Single(appeared), StringComparison.Ordinal);
    }

    [Fact]
    public void RekeyingARecordWithNoGroupFolder_FiledByHandWhereNoContainerHoldsIt_HasNoPlaceInTheTree()
    {
        var stray = new PlacedObject(_mod) { EditorID = "Stray" };
        File.WriteAllBytes(FullPath(Path.Combine(Root, "Worldspaces", PluginSourceRoot.Leaf(stray) + ".json")), Serialize(stray));

        var thrown = Assert.Throws<InvalidOperationException>(() => Repository.ChangesToRekey(Plugin, Identity(stray, "refr"), FreeFormKey));

        Assert.Contains("nowhere to write it", thrown.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ChangingTheFormKeyOfARecordNoDocumentCarries_IsRefusedNamingIt()
    {
        var absent = new SourceDocument("00FFFF:Embedded.esp", "refr", "Absent", "{}");

        var refused = Assert.IsType<SourceFailure.NotCarried>(Repository.ChangesToRekey(Plugin, absent.Identity, FreeFormKey).Stopped());

        Assert.Contains("00FFFF:Embedded.esp", refused.Reason, StringComparison.Ordinal);
    }

    public static TheoryData<string, Func<ISourceRepository, SourceDocument, RepositoriesLib.Answer<SourceChanges, SourceFailure>>> ChangesToAChildNoTypeHolds => new()
    {
        { "a rewrite", (repository, child) => repository.ChangesToRewrite(Plugin, child) },
        { "a rekey", (repository, child) => repository.ChangesToRekey(Plugin, child.Identity, FreeFormKey) },
    };

    [Theory]
    [MemberData(nameof(ChangesToAChildNoTypeHolds))]
    public void AChildItsOwnersTextNamesWhereItsTypeHoldsNone_IsRefusedAsNoDocumentHoldingIt(
        string _, Func<ISourceRepository, SourceDocument, RepositoriesLib.Answer<SourceChanges, SourceFailure>> changesTo)
    {
        var child = WriteAChildInASlotItsOwnerTypeHoldsNone();

        AssertRefusedAsAChildItsOwnersTextDoesNotCarry(Assert.IsType<SourceFailure.NotCarried>(changesTo(Repository, child).Stopped()));
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
    public void EveryChildAskedInOneOperation_IsFound_EmbeddedOrInAFileOfItsOwn()
    {
        var repository = Repository;
        IMajorRecordGetter[] children = [_persistentRef, _temporaryRef, _topCellRef, _exteriorRef, _topic, _response, _response2];

        var named = children.Select(child => repository.RecordByFormKey(Plugin, child.FormKey.ToString()).Value()?.EditorId);

        Assert.Equal(children.Select(child => child.EditorID), named);
    }

    [Fact]
    public void AChildAHandEditMovedToAnotherOwnerWithinOneOperation_IsFoundAtTheNewOwner_NotFromTheMapBuiltBeforeTheMove()
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
    public void AChildMovedTwiceWithinOneOperation_IsAbsent_NeverAtTheOwnerThatLostIt()
    {
        var repository = Repository;
        Assert.NotNull(repository.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")).Value());
        MoveTemporaryRef(_interiorCell, _exteriorCell);
        Assert.NotNull(repository.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")).Value());

        MoveTemporaryRef(_exteriorCell, _interiorCell);

        Assert.Null(repository.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")).Value());
    }

    [Fact]
    public void AChildInsideADocumentOfAPathAmbiguousGroup_IsInThatDocument_ThoughGlobalsMapsToFourTypesSoOnlyTheDocumentNamesItsOwn()
    {
        var child = WriteAChildInASlotItsOwnerTypeHoldsNone();

        Assert.Equal(
            Path.Combine(Root, RecordTypes.For(Release).GroupOf("globalfloat").Require(), $"Carrier - 00A000_{PluginName}.json"),
            Repository.RelativePathOf(Plugin, child.Identity).Value());
    }

    [Fact]
    public void RemovingAnEmbeddedChild_RewritesItsOwnersDocument_AndWritesNothing()
    {
        var before = File.ReadAllText(FullPath(InteriorCellPath));

        var changes = Repository.ChangesToRemove(Plugin, Identity(_temporaryRef, "refr")).Value();

        var owner = Assert.Single(changes.Documents);
        Assert.Equal(FullPath(InteriorCellPath), Path.Combine(_modFolder, owner.Path));
        Assert.DoesNotContain("\"TempRef\"", owner.Text, StringComparison.Ordinal);
        Assert.Contains("\"PersistRef\"", owner.Text, StringComparison.Ordinal);
        Assert.Empty(changes.Deletions);
        Assert.Equal(before, File.ReadAllText(FullPath(InteriorCellPath)));
    }

    [Theory]
    [InlineData(FiledChild.Topic)]
    [InlineData(FiledChild.Response)]
    public void RemovingAChildWithAFileOfItsOwn_DeletesItsFileOrItsDirectoryAlone(FiledChild child)
    {
        var (record, recordType, _, removed) = Filed(child);

        var changes = Repository.ChangesToRemove(Plugin, Identity(record, recordType)).Value();

        Assert.Equal([removed], changes.Deletions);
        Assert.Empty(changes.Documents);
    }

    private static SourceDocument ANewChild(IMajorRecordGetter record, string recordType) =>
        new(record.FormKey.ToString(), recordType, record.EditorID, RecordTextCodec.SerializeToText(record, Release));

    [Fact]
    public void PuttingAChildIntoAnEmbeddedContainersSlot_AppendsToItInItsOwnersDocument_AndWritesNothing()
    {
        var before = File.ReadAllText(FullPath(WorldspacePath));

        var changes = Repository.ChangesToPutChild(Plugin, Identity(_worldspace.TopCell.Require(), "cell"), "Temporary", ANewChild(AddedRef(), "refr")).Value();

        var owner = Assert.Single(changes.Documents);
        Assert.Equal(FullPath(WorldspacePath), Path.Combine(_modFolder, owner.Path));
        Assert.Contains("\"AddedRef\"", owner.Text, StringComparison.Ordinal);
        Assert.Empty(changes.Deletions);
        Assert.Equal(before, File.ReadAllText(FullPath(WorldspacePath)));
    }

    private PlacedObject AddedRef() => new(_mod) { EditorID = "AddedRef", Position = new P3Float(1f, 1f, 1f), Scale = 1f };

    [Fact]
    public void PuttingAChildIntoAnEmbeddedContainerWhoseOwnersDocumentAnotherToolRenamed_AppendsToTheRenamedDocument()
    {
        var renamed = Path.Combine(Path.GetDirectoryName(WorldspacePath).Require(), "Renamed by hand.json");
        File.Move(FullPath(WorldspacePath), FullPath(renamed));

        var changes = Repository.ChangesToPutChild(Plugin, Identity(_worldspace.TopCell.Require(), "cell"), "Temporary", ANewChild(AddedRef(), "refr")).Value();

        var owner = Assert.Single(changes.Documents);
        Assert.Equal(renamed, owner.Path);
        Assert.Contains("\"AddedRef\"", owner.Text, StringComparison.Ordinal);
    }

    [Fact]
    public void PuttingAResponseIntoATopic_WritesItsOwnFileInTheTopicsResponsesFolder_AndNoOtherDocument()
    {
        var added = new DialogResponses(_mod) { EditorID = "Response3" };

        var changes = Repository.ChangesToPutChild(Plugin, Identity(_topic, "dial"), "Responses", ANewChild(added, "info")).Value();

        var document = Assert.Single(changes.Documents);
        Assert.Equal((ResponsePath(added), RecordTextCodec.SerializeToText(added, Release)), (document.Path, document.Text));
        Assert.Empty(changes.Deletions);
    }

    [Fact]
    public void PuttingATopicIntoAQuest_WritesItsDocumentInADirectoryOfItsOwnInTheQuestsTopicsFolder()
    {
        var added = new DialogTopic(_mod) { EditorID = "Topic2" };

        var changes = Repository.ChangesToPutChild(Plugin, Identity(_quest, "qust"), "DialogTopics", ANewChild(added, "dial")).Value();

        Assert.Equal(
            PluginSourceRoot.ContainerDocument(Path.Combine(QuestDirectory, "DialogTopics", PluginSourceRoot.Leaf(added))),
            Assert.Single(changes.Documents).Path);
    }

    [Fact]
    public void PuttingAChildIntoASingleSlotThatHoldsARecord_IsRefusedAsTheSlotHeld()
    {
        var other = new Cell(_mod) { EditorID = "OtherTopCell" };

        var stopped = Repository.ChangesToPutChild(Plugin, Identity(_worldspace, "wrld"), "TopCell", ANewChild(other, "cell")).Stopped();

        Assert.IsType<SourceFailure.SlotHeld>(stopped);
    }

    [Fact]
    public void PuttingAChildIntoASlotItsContainersTextNamesTwice_IsUnreadable()
    {
        var text = File.ReadAllText(FullPath(InteriorCellPath));
        File.WriteAllText(FullPath(InteriorCellPath), text.Replace("\"Temporary\": [", "\"Temporary\": [],\n  \"Temporary\": [", StringComparison.Ordinal));
        var added = new PlacedObject(_mod) { EditorID = "AddedRef", Position = new P3Float(1f, 1f, 1f), Scale = 1f };

        var stopped = Repository.ChangesToPutChild(Plugin, Identity(_interiorCell, "cell"), "Temporary", ANewChild(added, "refr")).Stopped();

        Assert.IsType<SourceFailure.Unreadable>(stopped);
    }

    [Fact]
    public void PuttingAChildIntoAContainerNoDocumentHolds_IsNotCarried()
    {
        var added = new DialogResponses(_mod) { EditorID = "Response3" };

        var stopped = Repository.ChangesToPutChild(
            Plugin, new RecordIdentity("00FFFF:Embedded.esp", "dial", "Absent"), "Responses", ANewChild(added, "info")).Stopped();

        Assert.IsType<SourceFailure.NotCarried>(stopped);
    }

    [Fact]
    public void AKeyADocumentNamesOutsideEveryEmbedSlot_HasNoOwner_ForAFormKeyAnywhereElseIsAReferenceNotAChild()
    {
        var quest = File.ReadAllText(FullPath(QuestPath));
        File.WriteAllText(
            FullPath(QuestPath),
            quest.TrimEnd().TrimEnd('}') + ",\n  \"NotAChild\": { \"FormKey\": \"00A001:Embedded.esp\" }\n}");

        var identity = new RecordIdentity("00A001:Embedded.esp", "refr", "Absent");

        Assert.Null(Repository.RelativePathOf(Plugin, identity).Value());
        Assert.StartsWith(
            "No document in Embedded.esp's tree holds 00A001:Embedded.esp, so there is none to remove.", Repository.Remove(Plugin, identity).Failed().Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void RemovingAKeyASlotNamesButTheRecordDoesNotCarry_SaysTheOwnersTextLacksIt_ForOnlyTheCodecsObjectModelCanSayTheRecordHasNoSuchMember()
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
    public void TheFormKeysUsed_IncludeEveryChildsFormKey_EmbeddedOrInAFileOfItsOwn()
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
    public void AChildAnotherToolMovedBetweenTwoOperations_IsAtItsNewOwner()
    {
        Assert.NotNull(Repository.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")).Value());

        MoveTemporaryRef(_interiorCell, _exteriorCell);

        Assert.Equal(
            Path.GetRelativePath(_modFolder, FullPath(ExteriorCellPath)),
            TheNextOperation.RelativePathOf(Plugin, Identity(_temporaryRef, "refr")).Value());
    }

    [Fact]
    public void AChildInADocumentAnotherToolAddedBetweenTwoOperations_IsFound()
    {
        var added = new PlacedObject(_mod) { EditorID = "AddedRef", Position = new P3Float(1f, 1f, 1f), Scale = 1f };
        Assert.Null(IdentityIn(Repository, added));

        var cell = new Cell(_mod) { EditorID = "AddedCell" };
        cell.Temporary.Add(added);
        var path = FullPath(PluginSourceRoot.ContainerDocument(Path.Combine(Root, "Cells", "0", "0", PluginSourceRoot.Leaf(cell))));
        Directory.CreateDirectory(Path.GetDirectoryName(path) ?? throw new InvalidOperationException($"Expected '{path}' to have a parent directory."));
        File.WriteAllBytes(path, Serialize(cell));

        Assert.Equal(
            new RecordIdentity(added.FormKey.ToString(), "refr", "AddedRef"),
            TheNextOperation.RecordByFormKey(Plugin, added.FormKey.ToString()).Value()?.Identity);
    }

    [Fact]
    public void AChildAnotherToolRewroteUnderAnotherEditorIdBetweenTwoOperations_HasTheNewEditorId()
    {
        Assert.Equal("TempRef", IdentityIn(Repository, _temporaryRef)?.EditorId);

        _temporaryRef.EditorID = "RewrittenRef";
        File.WriteAllBytes(FullPath(InteriorCellPath), Serialize(_interiorCell));

        Assert.Equal("RewrittenRef", IdentityIn(TheNextOperation, _temporaryRef)?.EditorId);
    }

    [Fact]
    public void AChildWhoseFormKeyAnotherToolWroteThroughAJsonEscape_IsInItsOwner()
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
    public void AChild_IsReadFromItsOwnersText_HoweverDeepItNests()
    {
        _topCellRef.EditorID = "Edited";

        var read = Repository.RecordFromText(Plugin, _topCellRef.FormKey.ToString(), RecordTextCodec.SerializeToText(_worldspace, Release)).Value();

        Assert.Equal(new RecordIdentity(_topCellRef.FormKey.ToString(), "refr", "Edited"), read?.Identity);
        Assert.Equal("Edited", RootEditorId(read.Require().Body));
    }

    [Fact]
    public void AChild_IsReadFromItsOwnersText_ThoughTheTextChangedTheOwnersFormKeyToOneNothingHolds()
    {
        _temporaryRef.EditorID = "Edited";
        var text = RecordTextCodec.SerializeToText(_interiorCell, Release)
            .Replace(_interiorCell.FormKey.ToString(), "000FFF:Embedded.esp", StringComparison.Ordinal);

        var read = Repository.RecordFromText(Plugin, _temporaryRef.FormKey.ToString(), text).Value();

        Assert.Equal(new RecordIdentity(_temporaryRef.FormKey.ToString(), "refr", "Edited"), read?.Identity);
    }

    [Fact]
    public void TheTextGivenForAnOwnerThatNoLongerCarriesTheChild_IsRefusedSayingSo()
    {
        _interiorCell.Temporary.Clear();

        var refused = Assert.IsType<SourceFailure.Unreadable>(Repository.RecordFromText(
            Plugin, _temporaryRef.FormKey.ToString(), RecordTextCodec.SerializeToText(_interiorCell, Release)).Stopped());

        Assert.Equal($"The text given for {InteriorCellPath} does not carry {_temporaryRef.FormKey}.", refused.Reason);
    }

    [Fact]
    public void AChildNoDocumentInTheTreeCarries_IsNoRecord_NotItsOwnersTextReadAsIt()
    {
        var text = File.ReadAllText(FullPath(InteriorCellPath));
        File.Delete(FullPath(InteriorCellPath));

        Assert.Null(Repository.RecordFromText(Plugin, _temporaryRef.FormKey.ToString(), text).Value());
    }

    [Fact]
    public void AChildTwoDocumentsCarry_IsRefusedFromTheTextGivenForEither_NamingBoth()
    {
        _exteriorCell.Temporary.Add(_temporaryRef);
        File.WriteAllBytes(FullPath(ExteriorCellPath), Serialize(_exteriorCell));

        var refused = Assert.IsType<SourceFailure.Ambiguous>(
            Repository.RecordFromText(Plugin, _temporaryRef.FormKey.ToString(), File.ReadAllText(FullPath(InteriorCellPath))).Stopped());

        Assert.Equal(
            new ClaimedFormKey(_temporaryRef.FormKey.ToString(), [InteriorCellPath, ExteriorCellPath]),
            refused.Claim);
    }

    [Fact]
    public void AFileWhosePathAndTextNameNoRecordType_RefusesTheTreesRead_NamingItAndTheFormKeyItDeclares()
    {
        var untyped = Path.Combine(Root, "Untyped", "Gained.json");
        Directory.CreateDirectory(Path.GetDirectoryName(FullPath(untyped)).Require());
        File.WriteAllText(FullPath(untyped), """{"FormKey":"000ABC:Embedded.esp"}""");

        var refused = Assert.IsType<SourceFailure.Unreadable>(Repository.ReadDocuments(Plugin, tree => tree.Records.ToList()).Stopped());

        Assert.Equal((untyped, "000ABC:Embedded.esp"), (refused.File?.SourceRelativePath, refused.File?.FormKey));
        Assert.Contains("names a record type", refused.Reason, StringComparison.Ordinal);
    }
}

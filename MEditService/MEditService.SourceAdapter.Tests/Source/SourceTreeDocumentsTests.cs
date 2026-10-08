using System.Text;
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

public sealed class SourceTreeDocumentsTests : IDisposable
{
    private const string PluginName = "TreeDocuments.esp";
    private static readonly PluginAddress Plugin = new(PluginName, "TreeDocumentsMod");
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private readonly ScratchDirectory _modFolder = new("medit-treedocuments-");

    private readonly Fallout4Mod _mod = new(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

    private readonly Cell _interiorCell;
    private readonly PlacedObject _persistentRef;
    private readonly PlacedObject _temporaryRef;
    private readonly Landscape _landscape;
    private readonly Worldspace _worldspace;
    private readonly Cell _topCell;
    private readonly PlacedObject _topCellRef;
    private readonly Quest _quest;
    private readonly DialogTopic _topic;
    private readonly DialogResponses _response;

    private readonly string _interiorCellPath;
    private readonly string _worldspacePath;

    public SourceTreeDocumentsTests()
    {
        _persistentRef = new PlacedObject(_mod) { EditorID = "PersistRef", Position = new P3Float(1f, 2f, 3f), Scale = 4f };
        _temporaryRef = new PlacedObject(_mod) { EditorID = "TempRef", Position = new P3Float(11f, 22f, 33f), Scale = 1f };
        _landscape = new Landscape(_mod) { EditorID = "CellLandscape" };
        _interiorCell = new Cell(_mod) { EditorID = "InteriorCell", WaterHeight = 100f, Landscape = _landscape };
        _interiorCell.Persistent.Add(_persistentRef);
        _interiorCell.Temporary.Add(_temporaryRef);

        _topCellRef = new PlacedObject(_mod) { EditorID = "TopCellRef", Position = new P3Float(7f, 8f, 9f), Scale = 6f };
        _topCell = new Cell(_mod) { EditorID = "TopCell", WaterHeight = 5f };
        _topCell.Temporary.Add(_topCellRef);
        _worldspace = new Worldspace(_mod) { EditorID = "World", TopCell = _topCell };

        _response = new DialogResponses(_mod) { EditorID = "Response" };
        _topic = new DialogTopic(_mod) { EditorID = "Topic" };
        _topic.Responses.Add(_response);
        _quest = new Quest(_mod) { EditorID = "Quest" };
        _quest.DialogTopics.Add(_topic);

        _interiorCellPath = PluginSourceRoot.ContainerDocument(Path.Combine(Root, "Cells", "0", "0", Leaf(_interiorCell)));
        _worldspacePath = PluginSourceRoot.ContainerDocument(Path.Combine(Root, "Worldspaces", Leaf(_worldspace)));

        PluginBaselines.Track(
            _modFolder,
            [
                new TreeFile(_interiorCellPath, Serialize(_interiorCell)),
                new TreeFile(_worldspacePath, Serialize(_worldspace)),
                new TreeFile(Path.Combine(Root, "Quests", Leaf(_quest) + ".json"), Serialize(_quest)),
            ]);
    }

    public void Dispose() => _modFolder.Dispose();

    private static string Root => PluginSourceRoot.For(PluginName);

    private static string Leaf(IMajorRecordGetter record) =>
        $"{record.EditorID} - {record.FormKey.ID:X6}_{record.FormKey.ModKey.FileName}";

    private static byte[] Serialize(IMajorRecordGetter record) =>
        Encoding.UTF8.GetBytes(RecordTextCodec.SerializeToText(record, Release));

    private SourceRepository Repository =>
        SourceRepository.Open(TestMod.In(_modFolder), Release)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");

    private Dictionary<string, PluginDocument> Documents()
    {
        using var tree = Repository.OpenDocuments(Plugin);
        return tree.Records.ToDictionary(document => document.FormKey, document => document, StringComparer.Ordinal);
    }

    private List<IMajorRecordGetter> EveryEmbeddedChild() =>
        [_persistentRef, _temporaryRef, _landscape, _topCell, _topCellRef, _topic, _response];

    [Fact]
    public void EveryRecordTheFixtureEmbedsInAnother_ReadsBackAsItsOwnDocument()
    {
        var documents = Documents();

        Assert.Equal(
            EveryEmbeddedChild().Select(child => child.EditorID),
            EveryEmbeddedChild()
                .Where(child => documents.ContainsKey(child.FormKey.ToString()))
                .Select(child => child.EditorID));
    }

    [Fact]
    public void AChildInAListSlot_IsDeIndentedOutOfItsOwnerAndCarriesNoTypeDiscriminator()
    {
        var text = Documents()[_temporaryRef.FormKey.ToString()].Text;

        Assert.Equal(
            $$"""
            {
              "FormKey": "{{_temporaryRef.FormKey}}",
              "EditorID": "TempRef",
              "Scale": 1.0,
              "Position": "11, 22, 33"
            }
            """,
            text);
    }

    [Fact]
    public void AChildInsideAnEmbeddedChild_IsDeIndentedOnceForEachLevelItSitsUnder()
    {
        var documents = Documents();

        Assert.Equal(
            $$"""
            {
              "FormKey": "{{_topCell.FormKey}}",
              "EditorID": "TopCell",
              "WaterHeight": 5.0,
              "Temporary": [
                {
                  "MutagenObjectType": "PlacedObject",
                  "FormKey": "{{_topCellRef.FormKey}}",
                  "EditorID": "TopCellRef",
                  "Scale": 6.0,
                  "Position": "7, 8, 9"
                }
              ]
            }
            """,
            documents[_topCell.FormKey.ToString()].Text);
        Assert.Equal(
            $$"""
            {
              "FormKey": "{{_topCellRef.FormKey}}",
              "EditorID": "TopCellRef",
              "Scale": 6.0,
              "Position": "7, 8, 9"
            }
            """,
            documents[_topCellRef.FormKey.ToString()].Text);
    }

    [Fact]
    public void AChildInASingleValueSlot_IsTheSameBytesTheRepositorysGetAnswers()
    {
        var landscape = _landscape.FormKey.ToString();
        var document = Repository.RecordOf(Plugin, new RecordIdentity(landscape, "land", _landscape.EditorID))
            ?? throw new InvalidOperationException("Expected the landscape to have a source document.");

        Assert.Equal(document.Body, Documents()[landscape].Text);
    }

    [Fact]
    public void AnInteriorCell_SitsInTheBlockAndSubBlockItsDirectoriesAreNumbered()
    {
        var room = new Cell(_mod) { EditorID = "NumberedRoom" };
        var directory = Path.Combine(_modFolder, Root, "Cells", "3", "7", Leaf(room));
        Directory.CreateDirectory(directory);
        File.WriteAllBytes(PluginSourceRoot.ContainerDocument(directory), Serialize(room));

        Assert.Equal(CellStructure.Interior(3, 7), Documents()[room.FormKey.ToString()].Cell);
    }

    [Fact]
    public void AMemberNoRecordTypeDeclares_SurvivesAHandEditIntoAnEmbeddedChild()
    {
        var file = Path.Combine(_modFolder, _interiorCellPath);
        File.WriteAllText(
            file,
            File.ReadAllText(file).Replace(
                "\"EditorID\": \"TempRef\"",
                "\"EditorID\": \"TempRef\",\n      \"NoSuchMember\": 5",
                StringComparison.Ordinal));

        Assert.Contains(
            "\"NoSuchMember\": 5",
            Documents()[_temporaryRef.FormKey.ToString()].Text,
            StringComparison.Ordinal);
    }
}

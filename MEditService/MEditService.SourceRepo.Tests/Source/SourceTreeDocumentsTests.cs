using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.SourceRepo.Tests.Source;

/// <summary>The reader hands the index the documents the tree already holds. A child embedded in
/// its owner's document has no file of its own, so its text is cut back out of the owner's.</summary>
public sealed class SourceTreeDocumentsTests : IDisposable
{
    private const string PluginName = "TreeDocuments.esp";
    private static readonly PluginCopyKey Plugin = new(PluginName, "TreeDocumentsMod");
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-treedocuments-").FullName;
    private readonly RecordTextCodec _codec = new(NullLogger<RecordTextCodec>.Instance);

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

        _interiorCellPath = Path.Combine(Root, "Cells", "0", "0", Leaf(_interiorCell), "RecordData.json");
        _worldspacePath = Path.Combine(Root, "Worldspaces", Leaf(_worldspace), "RecordData.json");

        SourceRepository.Track(
            _modFolder,
            SourcePreset.Edits,
            [
                new TreeFile(_interiorCellPath, Serialize(_interiorCell)),
                new TreeFile(_worldspacePath, Serialize(_worldspace)),
                new TreeFile(Path.Combine(Root, "Quests", Leaf(_quest) + ".json"), Serialize(_quest)),
            ],
            new TrackProvenance(null, null, new Dictionary<string, string>()));
    }

    public void Dispose()
    {
        try { Directory.Delete(_modFolder, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
    }

    private static string Root => SourceRepository.RootFor(PluginName);

    private static string Leaf(IMajorRecordGetter record) =>
        $"{record.EditorID} - {record.FormKey.ID:X6}_{record.FormKey.ModKey.FileName}";

    private byte[] Serialize(IMajorRecordGetter record) =>
        _codec.SerializeToBytes(record, Release);

    private SourceRepository Repository =>
        SourceRepository.Open(_modFolder, Release)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");

    private Dictionary<string, PluginDocument> Documents()
    {
        using var tree = Repository.OpenDocuments(Plugin, SharedSchemaReflector.Instance.GetSchemas(Release));
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
        var document = Repository.Get(Plugin, new RecordIdentity(landscape, "land", _landscape.EditorID))
            ?? throw new InvalidOperationException("Expected the landscape to have a source document.");

        Assert.Equal(document.Body, Documents()[landscape].Text);
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

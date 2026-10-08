using System.Text;
using System.Text.Json;
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

public sealed class EmbeddedChildSpliceTests : IDisposable
{
    private const string PluginName = "Splice.esp";
    private const string DroppedByTheCodec = "\"NoSuchMember\": 5";
    private static readonly PluginAddress Plugin = new(PluginName, "SpliceMod");
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private readonly ScratchDirectory _modFolder = new("medit-splice-");
    private readonly RecordTextCodec _codec = new(NullLogger<RecordTextCodec>.Instance);
    private readonly Fallout4Mod _mod = new(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

    private readonly Cell _cell;
    private readonly Landscape _landscape;
    private readonly PlacedObject _persistentRef;
    private readonly PlacedObject _temporaryRef;
    private readonly Quest _quest;
    private readonly DialogTopic _topic;
    private readonly DialogResponses _response;
    private readonly DialogResponses _response2;

    public EmbeddedChildSpliceTests()
    {
        _persistentRef = new PlacedObject(_mod) { EditorID = "PersistRef", Position = new P3Float(1f, 2f, 3f), Scale = 4f };
        _temporaryRef = new PlacedObject(_mod) { EditorID = "TempRef", Position = new P3Float(11f, 22f, 33f), Scale = 1f };
        _landscape = new Landscape(_mod) { EditorID = "CellLandscape" };
        _cell = new Cell(_mod) { EditorID = "InteriorCell", WaterHeight = 100f, Landscape = _landscape };
        _cell.Persistent.Add(_persistentRef);
        _cell.Temporary.Add(_temporaryRef);

        _response = new DialogResponses(_mod) { EditorID = "Response" };
        _topic = new DialogTopic(_mod) { EditorID = "Topic" };
        _response2 = new DialogResponses(_mod) { EditorID = "Response2" };
        _topic.Responses.Add(_response);
        _topic.Responses.Add(_response2);
        _quest = new Quest(_mod) { EditorID = "Quest" };
        _quest.DialogTopics.Add(_topic);

        PluginBaselines.Track(
            _modFolder, PristineFiles());
    }

    public void Dispose() => _modFolder.Dispose();

    private TreeFile[] PristineFiles() =>
    [
        new(CellPath, Serialize(_cell)),
        new(QuestPath, Serialize(_quest)),
    ];

    private static string Root => PluginSourceRoot.For(PluginName);

    private string CellPath => PluginSourceRoot.ContainerDocument(Path.Combine(Root, "Cells", "0", "0", Leaf(_cell)));

    private string QuestPath => Path.Combine(Root, "Quests", Leaf(_quest) + ".json");

    private static string Leaf(IMajorRecordGetter record) =>
        $"{record.EditorID} - {record.FormKey.ID:X6}_{record.FormKey.ModKey.FileName}";

    private byte[] Serialize(IMajorRecordGetter record) =>
        Encoding.UTF8.GetBytes(_codec.SerializeToText(record, Release));

    private SourceRepository Repository =>
        SourceRepository.Open(TestMod.In(_modFolder), Release) ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");

    private static RecordIdentity Identity(IMajorRecordGetter record, string recordType) =>
        new(record.FormKey.ToString(), recordType, record.EditorID);

    private string FullPath(string relativePath) => Path.Combine(_modFolder, relativePath);

    private void HandEditDroppedMemberBeside(string relativePath, string anchor)
    {
        var text = File.ReadAllText(FullPath(relativePath));
        var line = text.Split('\n').First(l => l.Contains(anchor, StringComparison.Ordinal));
        var indent = new string(' ', line.Length - line.TrimStart().Length);
        File.WriteAllText(
            FullPath(relativePath),
            text.Replace(line, $"{indent}{DroppedByTheCodec},\n{line}", StringComparison.Ordinal));
    }

    [Fact]
    public void Get_OfAnEmbeddedChild_CarriesAMemberOfTheChildTheCodecWouldDrop()
    {
        HandEditDroppedMemberBeside(CellPath, "\"PersistRef\"");

        var body = Repository.Get(Plugin, Identity(_persistentRef, "refr"))?.Body;

        Assert.NotNull(body);
        Assert.Equal(_persistentRef.FormKey.ToString(), RootFormKeyOf(body));
        Assert.Contains(DroppedByTheCodec, body, StringComparison.Ordinal);
    }

    [Fact]
    public void Put_OfAnEmbeddedChild_LeavesEveryByteOutsideTheChildIdentical()
    {
        var before = File.ReadAllText(FullPath(CellPath));

        PutRenamedPersistentRef();

        var after = File.ReadAllText(FullPath(CellPath));
        Assert.NotEqual(before, after);
        Assert.Equal(
            WithoutTheBraceMatchedObjectHolding(before, _persistentRef.FormKey.ToString()),
            WithoutTheBraceMatchedObjectHolding(after, _persistentRef.FormKey.ToString()));
    }

    [Fact]
    public void Put_OfAnEmbeddedChild_KeepsAMemberOfTheOwnerTheCodecWouldDrop()
    {
        HandEditDroppedMemberBeside(CellPath, "\"WaterHeight\"");

        PutRenamedPersistentRef();

        var cellText = File.ReadAllText(FullPath(CellPath));
        Assert.Contains(DroppedByTheCodec, cellText, StringComparison.Ordinal);
        Assert.Contains("\"RenamedRef\"", cellText, StringComparison.Ordinal);
        Assert.Contains("\"TempRef\"", cellText, StringComparison.Ordinal);
    }

    [Fact]
    public void Put_OfAnEmbeddedChild_SpellsItInlineSoTheCodecStillReadsTheOwner()
    {
        PutRenamedPersistentRef();

        var owner = OwnerAsTheCodecReadsIt();

        Assert.Equal(["RenamedRef"], EditorIdsIn(owner, "Persistent"));
    }

    private JsonElement OwnerAsTheCodecReadsIt()
    {
        using var owner = JsonDocument.Parse(_codec.RoundTrip(File.ReadAllText(FullPath(CellPath)), Release, "cell"));
        return owner.RootElement.Clone();
    }

    private static string[] EditorIdsIn(JsonElement owner, string slot) =>
        owner.TryGetProperty(slot, out var held)
            ? [.. held.EnumerateArray().Select(placed => placed.GetProperty("EditorID").GetString()
                ?? throw new InvalidOperationException("Expected a placed ref to carry its EditorID."))]
            : [];

    private void PutRenamedPersistentRef()
    {
        var renamed = new PlacedObject(_persistentRef.FormKey, Fallout4Release.Fallout4)
        {
            EditorID = "RenamedRef",
            Position = new P3Float(9f, 9f, 9f),
            Scale = 7f,
        };

        Repository.Put(
            Plugin,
            new SourceDocument(
                _persistentRef.FormKey.ToString(), "refr", "RenamedRef",
                System.Text.Encoding.UTF8.GetString(Serialize(renamed))));
    }

    [Fact]
    public void Remove_OfTheOnlyChildOfAListSlot_TakesTheSlotWithIt()
    {
        Assert.Equal(SourceRemoval.Removed, Repository.Remove(Plugin, Identity(_persistentRef, "refr")));

        var cellText = File.ReadAllText(FullPath(CellPath));
        Assert.DoesNotContain("\"Persistent\"", cellText, StringComparison.Ordinal);
        Assert.DoesNotContain("\"PersistRef\"", cellText, StringComparison.Ordinal);
        Assert.Contains("\"TempRef\"", cellText, StringComparison.Ordinal);
        Assert.Contains("\"WaterHeight\": 100.0", cellText, StringComparison.Ordinal);
    }

    [Fact]
    public void Remove_OfAChildInASingleValueSlot_TakesTheSlotWithIt()
    {
        Assert.Equal(SourceRemoval.Removed, Repository.Remove(Plugin, Identity(_landscape, "land")));

        var cellText = File.ReadAllText(FullPath(CellPath));
        Assert.DoesNotContain("\"Landscape\"", cellText, StringComparison.Ordinal);
        Assert.Contains("\"PersistRef\"", cellText, StringComparison.Ordinal);
    }

    [Fact]
    public void Remove_OfAnEmbeddedChild_LeavesTheOwnerReadableByTheCodec()
    {
        Repository.Remove(Plugin, Identity(_persistentRef, "refr"));

        var owner = OwnerAsTheCodecReadsIt();

        Assert.Empty(EditorIdsIn(owner, "Persistent"));
        Assert.Equal(["TempRef"], EditorIdsIn(owner, "Temporary"));
        Assert.Equal("CellLandscape", owner.GetProperty("Landscape").GetProperty("EditorID").GetString());
    }

    [Fact]
    public void Remove_OfAnEmbeddedChild_KeepsAMemberOfTheOwnerTheCodecWouldDrop()
    {
        HandEditDroppedMemberBeside(CellPath, "\"WaterHeight\"");

        Assert.Equal(SourceRemoval.Removed, Repository.Remove(Plugin, Identity(_persistentRef, "refr")));

        Assert.Contains(DroppedByTheCodec, File.ReadAllText(FullPath(CellPath)), StringComparison.Ordinal);
    }

    [Fact]
    public void Remove_OfTheFirstChildOfAListSlot_LeavesTheOwnerSpelledAsTheCodecWould()
    {
        Assert.Equal(SourceRemoval.Removed, Repository.Remove(Plugin, Identity(_response, "info")));

        AssertTheCompileGateWouldNotRespell(QuestPath, "quest");
    }

    [Fact]
    public void Put_OfAnEmbeddedChild_LeavesTheOwnerSpelledAsTheCodecWould()
    {
        PutRenamedPersistentRef();

        AssertTheCompileGateWouldNotRespell(CellPath, "cell");
    }

    [Fact]
    public void Put_OfAnEmbeddedChild_AnswersEvenWhereTheCodecCannotReadASiblingChild()
    {
        var unreadable = File.ReadAllText(FullPath(CellPath))
            .Replace("\"PlacedObject\"", "\"NoSuchPlacedType\"", StringComparison.Ordinal);
        File.WriteAllText(FullPath(CellPath), unreadable);

        PutRenamedPersistentRef();

        var cellText = File.ReadAllText(FullPath(CellPath));
        Assert.Contains("\"RenamedRef\"", cellText, StringComparison.Ordinal);
        Assert.Contains("\"NoSuchPlacedType\"", cellText, StringComparison.Ordinal);
        Assert.Contains("\"TempRef\"", cellText, StringComparison.Ordinal);
    }

    private void AssertTheCompileGateWouldNotRespell(string relativePath, string recordType)
    {
        var text = File.ReadAllText(FullPath(relativePath));
        Assert.Equal(_codec.RoundTrip(text, Release, recordType), text);
    }

    private static string WithoutTheBraceMatchedObjectHolding(string text, string formKey)
    {
        var start = text.LastIndexOf('{', text.IndexOf(formKey, StringComparison.Ordinal));
        var depth = 0;
        var end = start;
        while (end < text.Length)
        {
            if (text[end] == '{') depth++;
            else if (text[end] == '}' && --depth == 0) break;
            end++;
        }
        return text[..start] + text[(end + 1)..];
    }

    private static string? RootFormKeyOf(string body)
    {
        using var document = JsonDocument.Parse(body);
        return document.RootElement.TryGetProperty("FormKey", out var formKey) ? formKey.GetString() : null;
    }
}

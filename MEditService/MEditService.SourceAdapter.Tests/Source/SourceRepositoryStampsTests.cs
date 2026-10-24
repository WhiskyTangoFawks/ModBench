using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryStampsTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string NpcFormKey = "000800:Fixture.esp";
    private static readonly string NpcBody = RecordTextCodec.SerializeToText(
        new Npc(FormKey.Factory(NpcFormKey), Fallout4Release.Fallout4) { EditorID = "FixtureNpc" }, GameRelease.Fallout4);

    private static readonly PluginAddress Plugin = new(PluginName, TestMod.Name);

    private readonly ScratchDirectory _modFolder = new("medit-stamps-");
    private readonly FakeTimeProvider _clock = new(TimeProvider.System.GetUtcNow());
    private readonly ISourceRepository _repository;

    public SourceRepositoryStampsTests()
    {
        PluginBaselines.InitWithNoRecords(_modFolder);
        _repository = TestAdapters.Source(_clock).Open(TestMod.In(_modFolder), GameRelease.Fallout4).Require();
        _repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", "FixtureNpc", NpcBody)).Wrote();
    }

    public void Dispose() => _modFolder.Dispose();

    private string NpcFile =>
        SourceDocumentPath.Of(_modFolder, PluginName, "npc_", NpcFormKey, "FixtureNpc", GameRelease.Fallout4);

    private string RelativeNpcFolder => Path.GetDirectoryName(Path.GetRelativePath(_modFolder, NpcFile)).Require();

    private static string StampOf(string text) => TestAdapters.Source().ContentStamp(text);

    [Fact]
    public void AContentStamp_IsEqualForEqualBytesAndDistinctForDifferentOnes()
    {
        var a = "{\n  \"Value\": 250\n}\n";
        var alsoA = "{\n  \"Value\": 250\n}\n";
        var b = "{\n  \"Value\": 251\n}\n";

        Assert.Equal(TestAdapters.Source().ContentStamp(a), TestAdapters.Source().ContentStamp(alsoA));
        Assert.NotEqual(TestAdapters.Source().ContentStamp(a), TestAdapters.Source().ContentStamp(b));
    }

    [Fact]
    public void EachDocument_IsListedByItsFormKey_WithTheStampOfItsBytes()
    {
        var stamps = _repository.StampsOf(Plugin);

        Assert.Equal(StampOf(NpcBody), stamps.ByFormKey[NpcFormKey]);
        Assert.Empty(stamps.Unreadable);
    }

    private void PastTheSettleWindow() => _clock.SetUtcNow(TimeProvider.System.GetUtcNow().AddSeconds(3));

    [Fact]
    public void AHandEditOfASettledFile_OfTheSameLengthKeepingTheModificationTime_IsStampedAsItsNewBytes()
    {
        var file = NpcFile;
        var modified = new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        File.SetLastWriteTimeUtc(file, modified);
        PastTheSettleWindow();
        _repository.StampsOf(Plugin);
        var edited = NpcBody.Replace("FixtureNpc", "FixtureNpX", StringComparison.Ordinal);
        File.WriteAllText(file, edited);
        File.SetLastWriteTimeUtc(file, modified);

        Assert.Equal(StampOf(edited), _repository.StampsOf(Plugin).ByFormKey[NpcFormKey]);
    }

    [Fact]
    public void AFileUnchangedAndSettled_IsNotReadAgain()
    {
        PastTheSettleWindow();
        _repository.StampsOf(Plugin);
        using var denyingSharingSoAnyReadWouldFail = new FileStream(NpcFile, FileMode.Open, FileAccess.Read, FileShare.None);

        var stamps = _repository.StampsOf(Plugin);

        Assert.Empty(stamps.Unreadable);
        Assert.Equal(StampOf(NpcBody), stamps.ByFormKey[NpcFormKey]);
    }

    [Fact]
    public void AFileChangedWithinTheSettleWindow_IsReadAgain()
    {
        _repository.StampsOf(Plugin);
        using var denyingSharingSoAnyReadWouldFail = new FileStream(NpcFile, FileMode.Open, FileAccess.Read, FileShare.None);

        Assert.Single(_repository.StampsOf(Plugin).Unreadable);
    }

    [Fact]
    public void AFileThatIsNotValidUtf8_IsStampedAsTheTextTheIndexStores()
    {
        var file = NpcFile;
        var bytes = File.ReadAllBytes(file);
        bytes[bytes.AsSpan().IndexOf("FixtureNpc"u8) + 1] = 0xFF;
        File.WriteAllBytes(file, bytes);

        Assert.Equal(StampOf(File.ReadAllText(file)), _repository.StampsOf(Plugin).ByFormKey[NpcFormKey]);
    }

    [Fact]
    public void AFileWithAnUnknownField_IsAProblemOnThatFile_AndStillAStampedDocument()
    {
        File.WriteAllText(NpcFile, NpcBody.Replace("\"FormKey\"", "\"NoSuchField\": 1,\n  \"FormKey\"", StringComparison.Ordinal));

        var stamps = _repository.StampsOf(Plugin);

        var problem = Assert.Single(stamps.Problems);
        Assert.Equal((Path.GetRelativePath(_modFolder, NpcFile), NpcFormKey), (problem.SourceRelativePath, problem.FormKey));
        Assert.Contains("NoSuchField", problem.Message, StringComparison.Ordinal);
        Assert.Contains(NpcFormKey, stamps.ByFormKey.Keys);
        Assert.Empty(stamps.Unreadable);
    }

    [Fact]
    public void AFlatRecordUnderAnotherLeafName_IsAProblemNamingWhereItBelongs()
    {
        var original = NpcFile;
        var misplaced = Path.Combine(Path.GetDirectoryName(original).Require(), "Renamed.json");
        File.Move(original, misplaced);

        var problem = Assert.Single(_repository.StampsOf(Plugin).Problems);

        Assert.Equal(Path.GetRelativePath(_modFolder, misplaced), problem.SourceRelativePath);
        Assert.Contains($"belongs at {Path.GetRelativePath(_modFolder, original)}", problem.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ARecordOutsideTheLightRangeOfALightHeader_IsAProblemOnItsFile()
    {
        var light = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4) { IsSmallMaster = true };
        File.WriteAllBytes(Path.Combine(_modFolder, PluginSourceRoot.HeaderDocument(PluginName)), HeaderDocument.Write(light));
        var outside = SourceDocumentPath.Of(_modFolder, PluginName, "npc_", "001000:Fixture.esp", "Far", GameRelease.Fallout4);
        Directory.CreateDirectory(Path.GetDirectoryName(outside).Require());
        File.WriteAllText(outside, RecordTextCodec.SerializeToText(
            new Npc(FormKey.Factory("001000:Fixture.esp"), Fallout4Release.Fallout4) { EditorID = "Far" }, GameRelease.Fallout4));

        var problem = Assert.Single(_repository.StampsOf(Plugin).Problems);

        Assert.Equal(Path.GetRelativePath(_modFolder, outside), problem.SourceRelativePath);
        Assert.Contains("light range", problem.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ABlockLevelDocumentWithAValueOfTheWrongType_IsAProblemOnThatFile()
    {
        var level = Path.Combine(_modFolder, PluginSourceRoot.For(PluginName), "Cells", "0", "GroupRecordData.json");
        Directory.CreateDirectory(Path.GetDirectoryName(level).Require());
        File.WriteAllText(level, "{\"BlockNumber\": \"text\"}");

        var problem = Assert.Single(_repository.StampsOf(Plugin).Problems);

        Assert.Equal(Path.GetRelativePath(_modFolder, level), problem.SourceRelativePath);
        Assert.Contains("BlockNumber", problem.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ATreeWhoseOnlyChangeIsAFileMovedOutOfPlace_IsNotTheSameStamps()
    {
        var placed = _repository.StampsOf(Plugin);
        File.Move(NpcFile, Path.Combine(Path.GetDirectoryName(NpcFile).Require(), "Renamed.json"));

        Assert.NotEqual(placed, _repository.StampsOf(Plugin));
    }

    [Fact]
    public void AFileDeclaringNoFormKey_IsUnreadable()
    {
        File.WriteAllText(Path.Combine(Path.GetDirectoryName(NpcFile).Require(), "Stray - 000A00_Fixture.esp.json"), "{\"EditorID\":\"Stray\"}");

        var stamps = _repository.StampsOf(Plugin);

        var unreadable = Assert.Single(stamps.Unreadable);
        Assert.Equal(Path.Combine(RelativeNpcFolder, "Stray - 000A00_Fixture.esp.json"), unreadable.SourceRelativePath);
    }

    [Fact]
    public void AFileThatIsNotValidJson_IsUnreadableWhereTheReaderStopped()
    {
        File.WriteAllText(NpcFile, "{\n  \"FormKey\": \"000800:Fixture.esp\",\n  \"EditorID\": }");

        var unreadable = Assert.Single(_repository.StampsOf(Plugin).Unreadable);

        Assert.Contains("is no record document", unreadable.Message, StringComparison.Ordinal);
        Assert.Contains("LineNumber: 2", unreadable.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AFileOfValidJsonWhoseRootIsAnArray_IsUnreadableForItsRootIsNoObject_NotForInvalidJson()
    {
        File.WriteAllText(NpcFile, "[1, 2]");

        var unreadable = Assert.Single(_repository.StampsOf(Plugin).Unreadable);

        Assert.Contains("its root is not a JSON object", unreadable.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("not valid JSON", unreadable.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AFormKeyTwoDocumentsDeclare_IsClaimedByBoth()
    {
        var file = Path.GetRelativePath(_modFolder, NpcFile);
        var twin = Path.Combine(Path.GetDirectoryName(file).Require(), "Twin - 000800_Fixture.esp.json");
        File.Copy(Path.Combine(_modFolder, file), Path.Combine(_modFolder, twin));

        var claim = Assert.Single(_repository.StampsOf(Plugin).Claimed);

        Assert.Equal(NpcFormKey, claim.FormKey);
        Assert.Equal([file, twin], claim.Documents.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void APluginWithNoTree_HasNoStamps()
    {
        var stamps = _repository.StampsOf(new PluginAddress("Absent.esp", TestMod.Name));

        Assert.Empty(stamps.ByFormKey);
        Assert.Empty(stamps.Unreadable);
        Assert.Empty(stamps.Claimed);
    }
}

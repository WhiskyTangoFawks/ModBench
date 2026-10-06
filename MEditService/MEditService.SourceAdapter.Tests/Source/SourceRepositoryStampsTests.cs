using MEditService.LoadOrder;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.Source;

public sealed class SourceRepositoryStampsTests : IDisposable
{
    private const string PluginName = "Fixture.esp";
    private const string NpcFormKey = "000800:Fixture.esp";
    private const string NpcBody = "{\n  \"FormKey\": \"000800:Fixture.esp\",\n  \"EditorID\": \"FixtureNpc\"\n}";

    private static readonly PluginAddress Plugin = new(PluginName, "FixtureMod");

    private readonly ScratchDirectory _modFolder = new("medit-stamps-");
    private readonly SourceRepository _repository;

    public SourceRepositoryStampsTests()
    {
        PluginBaselines.TrackWithNoRecords(_modFolder);
        _repository = SourceRepository.Open(TestMod.In(_modFolder), GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to be tracked.");
        _repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", "FixtureNpc", NpcBody));
    }

    public void Dispose() => _modFolder.Dispose();

    private string NpcFile =>
        SourceDocumentPath.Of(_modFolder, PluginName, "npc_", NpcFormKey, "FixtureNpc", GameRelease.Fallout4);

    private string RelativeNpcFolder => Path.GetDirectoryName(Path.GetRelativePath(_modFolder, NpcFile)).Require();

    private static string StampOf(string text) => SourceRepository.ContentStamp(text);

    [Fact]
    public void ContentStamp_IsEqualForEqualBytesAndDistinctForDifferentOnes()
    {
        var a = "{\n  \"Value\": 250\n}\n";
        var alsoA = "{\n  \"Value\": 250\n}\n";
        var b = "{\n  \"Value\": 251\n}\n";

        Assert.Equal(SourceRepository.ContentStamp(a), SourceRepository.ContentStamp(alsoA));
        Assert.NotEqual(SourceRepository.ContentStamp(a), SourceRepository.ContentStamp(b));
    }

    [Fact]
    public void StampsOf_ListsEachDocumentByItsFormKey_WithTheStampOfItsBytes()
    {
        var stamps = _repository.StampsOf(Plugin);

        Assert.Equal(StampOf(NpcBody), stamps.ByFormKey[NpcFormKey]);
        Assert.Empty(stamps.Unreadable);
    }

    private static Task PastTheSettleWindow() => Task.Delay(TimeSpan.FromSeconds(2.2));

    [Fact]
    public async Task StampsOf_AfterAHandEditOfTheSameLengthKeepingTheModificationTime_NamesTheNewBytes_OfASettledFile()
    {
        var file = NpcFile;
        var modified = new DateTime(2020, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        File.SetLastWriteTimeUtc(file, modified);
        await PastTheSettleWindow();
        _repository.StampsOf(Plugin);
        var edited = NpcBody.Replace("FixtureNpc", "FixtureNpX", StringComparison.Ordinal);
        File.WriteAllText(file, edited);
        File.SetLastWriteTimeUtc(file, modified);

        Assert.Equal(StampOf(edited), _repository.StampsOf(Plugin).ByFormKey[NpcFormKey]);
    }

    [Fact]
    public async Task StampsOf_AFileUnchangedAndSettled_IsNotReadAgain()
    {
        await PastTheSettleWindow();
        _repository.StampsOf(Plugin);
        using var denyingSharingSoAnyReadWouldFail = new FileStream(NpcFile, FileMode.Open, FileAccess.Read, FileShare.None);

        var stamps = _repository.StampsOf(Plugin);

        Assert.Empty(stamps.Unreadable);
        Assert.Equal(StampOf(NpcBody), stamps.ByFormKey[NpcFormKey]);
    }

    [Fact]
    public void StampsOf_AFileChangedWithinTheSettleWindow_IsReadAgain()
    {
        _repository.StampsOf(Plugin);
        using var denyingSharingSoAnyReadWouldFail = new FileStream(NpcFile, FileMode.Open, FileAccess.Read, FileShare.None);

        Assert.Single(_repository.StampsOf(Plugin).Unreadable);
    }

    [Fact]
    public void StampsOf_AFileThatIsNotValidUtf8_StampsTheTextTheIndexStores()
    {
        var file = NpcFile;
        var bytes = File.ReadAllBytes(file);
        bytes[bytes.AsSpan().IndexOf("FixtureNpc"u8) + 1] = 0xFF;
        File.WriteAllBytes(file, bytes);

        Assert.Equal(StampOf(File.ReadAllText(file)), _repository.StampsOf(Plugin).ByFormKey[NpcFormKey]);
    }

    [Fact]
    public void StampsOf_AFileDeclaringNoFormKey_IsReportedUnreadable()
    {
        File.WriteAllText(Path.Combine(Path.GetDirectoryName(NpcFile).Require(), "Stray - 000A00_Fixture.esp.json"), "{\"EditorID\":\"Stray\"}");

        var stamps = _repository.StampsOf(Plugin);

        var unreadable = Assert.Single(stamps.Unreadable);
        Assert.Equal(Path.Combine(RelativeNpcFolder, "Stray - 000A00_Fixture.esp.json"), unreadable.SourceRelativePath);
    }

    [Fact]
    public void StampsOf_AFileThatIsNotValidJson_SaysSo_WhereTheReaderStopped()
    {
        File.WriteAllText(NpcFile, "{\n  \"FormKey\": \"000800:Fixture.esp\",\n  \"EditorID\": }");

        var unreadable = Assert.Single(_repository.StampsOf(Plugin).Unreadable);

        Assert.Contains("is not valid JSON", unreadable.Message, StringComparison.Ordinal);
        Assert.Contains("LineNumber: 2", unreadable.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void StampsOf_AFormKeyTwoDocumentsDeclare_NamesItWithBothDocuments()
    {
        var file = Path.GetRelativePath(_modFolder, NpcFile);
        var twin = Path.Combine(Path.GetDirectoryName(file).Require(), "Twin - 000800_Fixture.esp.json");
        File.Copy(Path.Combine(_modFolder, file), Path.Combine(_modFolder, twin));

        var claim = Assert.Single(_repository.StampsOf(Plugin).Claimed);

        Assert.Equal(NpcFormKey, claim.FormKey);
        Assert.Equal([file, twin], claim.Documents.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void StampsOf_APluginWithNoTree_ListsNothing()
    {
        var stamps = _repository.StampsOf(new PluginAddress("Absent.esp", "FixtureMod"));

        Assert.Empty(stamps.ByFormKey);
        Assert.Empty(stamps.Unreadable);
        Assert.Empty(stamps.Claimed);
    }
}

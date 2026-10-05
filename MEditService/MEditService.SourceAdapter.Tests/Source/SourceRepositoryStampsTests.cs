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
        _repository = SourceRepository.Open(_modFolder, GameRelease.Fallout4)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to be tracked.");
        _repository.Put(Plugin, new SourceDocument(NpcFormKey, "npc_", "FixtureNpc", NpcBody));
    }

    public void Dispose() => _modFolder.Dispose();

    private string NpcFile =>
        SourceDocumentPath.Of(_modFolder, PluginName, "npc_", NpcFormKey, "FixtureNpc", GameRelease.Fallout4);

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

        Assert.Single(stamps.Unreadable);
        Assert.Contains("Stray", stamps.Unreadable[0], StringComparison.Ordinal);
    }

    [Fact]
    public void StampsOf_AFormKeyTwoDocumentsDeclare_Throws()
    {
        var file = NpcFile;
        File.Copy(file, Path.Combine(Path.GetDirectoryName(file).Require(), "Twin - 000800_Fixture.esp.json"));

        Assert.Throws<AmbiguousSourceUnitException>(() => _repository.StampsOf(Plugin));
    }

    [Fact]
    public void StampsOf_APluginWithNoTree_ListsNothing()
    {
        var stamps = _repository.StampsOf(new PluginAddress("Absent.esp", "FixtureMod"));

        Assert.Empty(stamps.ByFormKey);
        Assert.Empty(stamps.Unreadable);
    }
}

using System.Diagnostics;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;
using static MEditService.TestSupport.RawPlugin;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class RecordLookupFactsTests : IDisposable
{
    private const string PluginName = "Many.esp";
    private const int RecordCount = 60_000;
    private const string FirstRecord = "000800:" + PluginName;

    private readonly PluginFixtureData _data = new PluginFixtureBuilder("adapter-record-lookup-facts").WithPlugin(PluginName).Build();

    private readonly MutagenPluginAdapter _adapter = new(new FakeTimeProvider(TimeProvider.System.GetUtcNow() + TimeSpan.FromHours(1)));

    private string PluginPath => Path.Combine(_data.DataFolder, PluginName);

    public void Dispose() => _data.Dispose();

    private void WriteRecords(string editorIdOfFirst) =>
        File.WriteAllBytes(PluginPath, Plugin(
            Tes4(),
            Group("MISC", [.. Enumerable.Range(0, RecordCount).Select(index => Misc(0x800 + (uint)index, index == 0 ? editorIdOfFirst : $"Misc{index}"))])));

    private IPluginRecords Open() =>
        _adapter.OpenRecordLookup(
            new RegisteredPlugin(PluginName, PluginOrigin.DataDirectory, PluginPath, PluginProvider.Game, Line: null, PluginStrings.None),
            EmptyLoadOrder.Of(GameRelease.Fallout4), SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)).Answered();

    private static TimeSpan Timed(Action ask)
    {
        var watch = Stopwatch.StartNew();
        ask();
        return watch.Elapsed;
    }

    [Fact]
    public void ALaterLookupOfAnUnchangedPlugin_AnswersWithoutWalkingItsRecordsAgain()
    {
        WriteRecords("First");
        using var earlier = Open();
        using var later = Open();

        var walked = Timed(() => earlier.IdentityOf(FirstRecord).Answered());
        var kept = Timed(() => later.IdentityOf(FirstRecord).Answered());

        Assert.True(kept * 10 < walked, $"The earlier lookup took {walked}; the later one took {kept}.");
    }

    [Fact]
    public void ALookupOfAPluginChangedSinceTheEarlierOne_AnswersFromWhatItHolds()
    {
        WriteRecords("First");
        using (var earlier = Open()) Assert.Equal("First", earlier.IdentityOf(FirstRecord).Answered()?.EditorId);

        WriteRecords("Other");
        using var later = Open();

        Assert.Equal("Other", later.IdentityOf(FirstRecord).Answered()?.EditorId);
    }
}

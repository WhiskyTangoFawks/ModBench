using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using static MEditService.Index.Tests.TestSupport.Announcements;

namespace MEditService.Index.Tests.Plugins;

public sealed class SourceWriteTests : IDisposable
{
    private const string Tracked = "Tracked.esp";
    private static readonly TimeSpan Bound = TimeSpan.FromSeconds(30);

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _tracked;
    private readonly string _npc;
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly HookedSource _source;
    private readonly OpenedIndex _index;
    private readonly string _file;
    private Action? _atStamps;
    private Action? _atTreeAsked;

    public SourceWriteTests()
    {
        string npc = "";
        _fixture = new PluginFixtureBuilder("source-write")
            .WithPlugin(Tracked, mod => npc = mod.Npcs.AddNew("TrackedNpc").FormKey.ToString(), origin: "TrackedMod")
            .BuildScattered();
        _tracked = _fixture.Plugins.Single(p => p.Name == Tracked);
        _npc = npc;
        TrackedMods.Track(_tracked);
        _source = new HookedSource((moment, _) =>
        {
            if (moment == TreeMoment.StampsTaken) Interlocked.Exchange(ref _atStamps, null)?.Invoke();
            if (moment == TreeMoment.TreeAsked) Interlocked.Exchange(ref _atTreeAsked, null)?.Invoke();
        });
        _index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, notifications: _notifications, source: _source);
        _file = _tracked.SourceFileOf(_index.DocumentOf(_npc, _tracked.KeyOf()));
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private void WriteEditorId(string editorId)
    {
        var folder = _tracked.ModFolderOf();
        var session = _source.WriteSessionOver(new PluginProvider.FromMod(_tracked.Origin, folder, folder), GameRelease.Fallout4, []);
        var text = File.ReadAllText(_file).Replace("\"TrackedNpc\"", $"\"{editorId}\"", StringComparison.Ordinal);
        Assert.Null(session.Atomically(() => session.Apply(SourceAnswer.Of(new SourceChanges([], [], [new DocumentChange(_file, text)])))));
        session.Write().Wrote();
    }

    private string EditorIdRead() => _index.DocumentOf(_npc, _tracked.KeyOf()).EditorId ?? "";

    [Fact]
    public void AReadAfterAWriteTheSourceAdapterMade_SeesTheWrite()
    {
        WriteEditorId("Written");

        Assert.Equal("Written", EditorIdRead());
    }

    [Fact]
    public async Task AReadWhileTheWriteIsValidated_WaitsForItsRows()
    {
        using var validating = new ManualResetEventSlim();
        using var released = new ManualResetEventSlim();
        _atStamps = () =>
        {
            validating.Set();
            released.Wait(Bound);
        };
        WriteEditorId("Written");
        Assert.True(validating.Wait(Bound));

        var read = Task.Run(EditorIdRead);
        var first = await Task.WhenAny(read, Task.Delay(TimeSpan.FromMilliseconds(500)));
        released.Set();

        Assert.NotSame(read, first);
        Assert.Equal("Written", await read);
    }

    [Fact]
    public void AValidationOfAWriteThatTimesOut_IsMadeAgain_BeforeAReadAnswers()
    {
        _atTreeAsked = () => throw new TimeoutException("Another write held the index.");

        WriteEditorId("Written");

        Assert.Equal("Written", EditorIdRead());
        Assert.Equal(LoadOrderState.Ready, _index.Status.State);
    }

    [Fact]
    public void AWriteTheSourceAdapterMade_IsAnnouncedAsTheRowsItChanged()
    {
        var before = _notifications.Notifications.Count;

        WriteEditorId("Written");

        Waits.Reached(() => _notifications.Since(before).Any(n => RowsChanged(_npc)(n)), "the written record's rows changing");
    }
}

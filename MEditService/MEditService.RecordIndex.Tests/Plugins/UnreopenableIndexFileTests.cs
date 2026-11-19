using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class UnreopenableIndexFileTests : IDisposable
{
    private const string Aborted = "Aborted.esp";

    private readonly PluginFixtureData _fixture = new PluginFixtureBuilder("unreopenable-index-file")
        .WithPlugin(Aborted, mod => mod.Npcs.AddNew("AbortedNpc"))
        .Build();

    private readonly LoadOrderHolder _holder = new();
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly ILoggerFactory _loggers;
    private readonly string _indexFolder;
    private readonly OpenedIndex _index;
    private bool _otherWindowTakesTheFile;
    private ForeignIndexHolder? _otherWindow;
    private bool _indexFolderLocked;

    public UnreopenableIndexFileTests()
    {
        _loggers = LoggerFactory.Create(b => b.SetMinimumLevel(LogLevel.Debug).AddProvider(new CollectingLoggerProvider([], entry =>
        {
            if (Volatile.Read(ref _otherWindowTakesTheFile) && entry.Message.StartsWith("Initializing record index", StringComparison.Ordinal))
                _otherWindow ??= ForeignIndexHolder.Hold(IndexFiles.In(_fixture.InstanceRoot));
        })));
        _index = Indexes.Open(_holder, new AbortingDuckDbsCheckpoint(_fixture.InstanceRoot, Aborted, nthRead: 2), _loggers, _notifications);
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        _indexFolder = Path.GetDirectoryName(IndexFiles.In(_fixture.InstanceRoot)) ?? throw new InvalidOperationException("The index file has a folder.");
    }

    public void Dispose()
    {
        _otherWindow?.Dispose();
        if (_indexFolderLocked) FileModes.Set(_indexFolder, "700");
        _index.Dispose();
        _fixture.Dispose();
        _loggers.Dispose();
    }

    [PosixFact]
    public void AFatalError_WhoseReopenFails_PublishesAFailedStatusThatSaysSo_NamingTheFatalErrorAndTheIndexFile()
    {
        LockIndexFolder();
        var before = _notifications.Notifications.Count;

        RewriteAborted();

        NextCheckSaysTheReopenFailed(before);
    }

    [PosixFact]
    public void AStoreInvalidatedBeforeTheCheck_WhoseReopenFails_PublishesAFailedStatusThatSaysSo_NamingTheFatalErrorAndTheIndexFile()
    {
        IndexFiles.Invalidate(_fixture.InstanceRoot);
        LockIndexFolder();
        var before = _notifications.Notifications.Count;

        NextCheckSaysTheReopenFailed(before);
    }

    [ForeignIndexHolderFact]
    public void AFatalErrorDuringTheCheck_WhoseReopenFindsAnotherWindowHoldingTheFile_IsHeldElsewhere_UntilARefreshOnceThatWindowCloses()
    {
        Volatile.Write(ref _otherWindowTakesTheFile, true);
        var before = _notifications.Notifications.Count;

        RewriteAborted();

        NextCheckIsHeldElsewhere(before);
    }

    [ForeignIndexHolderFact]
    public void AStoreInvalidatedBeforeTheCheck_WhoseReopenFindsAnotherWindowHoldingTheFile_IsHeldElsewhere_UntilARefreshOnceThatWindowCloses()
    {
        IndexFiles.Invalidate(_fixture.InstanceRoot);
        Volatile.Write(ref _otherWindowTakesTheFile, true);
        var before = _notifications.Notifications.Count;

        NextCheckIsHeldElsewhere(before);
    }

    private void LockIndexFolder()
    {
        FileModes.Set(_indexFolder, "500");
        _indexFolderLocked = true;
    }

    private void RewriteAborted()
    {
        var rewritten = new Fallout4Mod(ModKey.FromFileName(Aborted), Fallout4Release.Fallout4);
        rewritten.Npcs.AddNew("RewrittenNpc");
        rewritten.WriteToBinary(_fixture.Plugins.Single().Path);
    }

    private void NextCheckSaysTheReopenFailed(int before) =>
        _index.NextCheckUnsettledUntil(
            () => _notifications.Since(before).Any(n => n is LoadOrderStatusNotification { Status: { State: LoadOrderState.Failed, Message: { } message } }
                && message.Contains("FATAL Error", StringComparison.Ordinal)
                && message.Contains("mEdit's record index was not reopened: ", StringComparison.Ordinal)
                && message.Contains("index.duckdb", StringComparison.Ordinal)),
            "a Failed status saying the reopen failed, naming the fatal error and the index file");

    private void NextCheckIsHeldElsewhere(int before)
    {
        LoadOrderStatus? Refused() => _notifications.Since(before).OfType<LoadOrderStatusNotification>()
            .FirstOrDefault(n => n.Status.State is LoadOrderState.HeldElsewhere or LoadOrderState.Failed)?.Status;

        _index.NextCheckUnsettledUntil(() => Refused() is not null, "the reopen's refusal");

        var refused = Refused().Require();
        Assert.Equal(LoadOrderState.HeldElsewhere, refused.State);
        Assert.Contains("another Modbench window", refused.Message, StringComparison.Ordinal);
        Assert.Contains("Close that window, then refresh.", refused.Message, StringComparison.Ordinal);
    }
}

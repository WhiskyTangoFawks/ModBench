using System.Text;
using MEditService.Core.Notifications;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary>ADR-0046 invariant 12, the in-memory adapter: the same Index verbs the write API
/// reaches publish rows-changed through the port with no HTTP or SSE stream involved, proving the
/// port — not the transport — is the seam.</summary>
public sealed class RowsChangedNotificationTests : IDisposable
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);
    private static readonly PluginKey BaseKey = new("Base.esm", "Data");
    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

    private readonly PluginFixtureData _fixture;
    private readonly FormKey _npc;
    private readonly InMemoryNotificationPublisher _notifications = new();

    public RowsChangedNotificationTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("rows-changed-notification")
            .WithPlugin("Base.esm", mod => npc = mod.Npcs.AddNew("OriginalName").FormKey)
            .Build();
        _npc = npc;
    }

    public void Dispose() => _fixture.Dispose();

    private DuckDbRecordIndex LoadedIndex()
    {
        var index = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance, notifications: _notifications);
        index.Initialize(GameRelease.Fallout4);
        var path = new ModPath(ModKey.FromFileName("Base.esm"), Path.Combine(_fixture.DataFolder, "Base.esm"));
        index.Index(Fallout4Mod.CreateFromBinaryOverlay(path, Fallout4Release.Fallout4), Registration.Participating(0), BaseKey);
        index.UpdateWinners();
        return index;
    }

    private static string NpcBody(string formKey, string editorId)
    {
        var npc = new Npc(FormKey.Factory(formKey), Fallout4Release.Fallout4) { EditorID = editorId };
        var bytes = Codec.SerializeToBytesAsync(npc, GameRelease.Fallout4).GetAwaiter().GetResult();
        return Encoding.UTF8.GetString(bytes);
    }

    [Fact]
    public void ApplyWorkingTreeChanges_PublishesRowsChanged_WithTheKeyAndTheSequenceAfterTheWrite()
    {
        using var index = LoadedIndex();
        var formKey = _npc.ToString();
        var editedBody = index.At(RecordRef.Effective).GetDocument(formKey, BaseKey)!.Body!
            .Replace("OriginalName", "EditedName", StringComparison.Ordinal);

        index.ApplyWorkingTreeChanges(BaseKey, [(formKey, editedBody)]);

        var notification = Assert.IsType<RowsChangedNotification>(Assert.Single(_notifications.Notifications));
        Assert.Equal(BaseKey, notification.Plugin);
        Assert.Equal([formKey], notification.Keys);
        Assert.Equal(index.Sequence, notification.Sequence);
    }

    [Fact]
    public void CreateWorkingTreeRecord_PublishesRowsChanged_WithTheNewKey()
    {
        using var index = LoadedIndex();
        var formKey = "800000:Base.esm";

        index.CreateWorkingTreeRecord(BaseKey, formKey, "npc_", NpcBody(formKey, "NewNpc"));

        var notification = Assert.IsType<RowsChangedNotification>(Assert.Single(_notifications.Notifications));
        Assert.Equal(BaseKey, notification.Plugin);
        Assert.Equal([formKey], notification.Keys);
        Assert.Equal(index.Sequence, notification.Sequence);
    }

    [Fact]
    public void ApplyRenumber_PublishesRowsChanged_WithBothTheOldAndTheNewKey()
    {
        using var index = LoadedIndex();
        var oldFormKey = _npc.ToString();
        var newFormKey = "800000:Base.esm";

        index.ApplyRenumber(BaseKey, new RenumberedRecord(oldFormKey, newFormKey, "npc_", NpcBody(newFormKey, "Renumbered")));

        var notification = Assert.IsType<RowsChangedNotification>(Assert.Single(_notifications.Notifications));
        Assert.Equal(BaseKey, notification.Plugin);
        Assert.Equal([oldFormKey, newFormKey], notification.Keys);
        Assert.Equal(index.Sequence, notification.Sequence);
    }
}

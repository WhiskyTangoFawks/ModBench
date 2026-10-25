using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using static MEditService.Commands.Tests.TestSupport.LoadOrderOfPlugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class ParseFailedCopyRefusalTests : IDisposable
{
    private static readonly string UnreadablePerk = MisshapedPerkPlugin.FormKey;
    private const string Diagnosis = "did not have expected parameter type flag";

    private readonly LoadOrderOfPlugins _mod = new();
    private readonly PluginAddress _sourcePlugin;
    private readonly PluginAddress _destinationPlugin;

    public ParseFailedCopyRefusalTests()
    {
        var source = Plugin(MisshapedPerkPlugin.FileName, _ => { });
        var destination = Plugin("Destination.esp", _ => { });
        _mod.Load((Plugin("Fallout4.esm", _ => { }), false), (source, false), (destination, true));
        _mod.Rewrite(source, path => File.WriteAllBytes(path, MisshapedPerkPlugin.Plugin.Bytes));
        (_sourcePlugin, _destinationPlugin) = (Address(source), Address(destination));
    }

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void CopyRecordAsOverride_OfAParseFailedRecord_IsRefusedWithItsDiagnosis_AndWritesNothing()
    {
        var result = _mod.CopyHandler.CopySync([new RecordAt(_sourcePlugin, UnreadablePerk)], CopyMode.Override, [_destinationPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.RecordParseFailed, refused.Refusal);
        Assert.Contains(
            $"{UnreadablePerk} ({MisshapedPerkPlugin.EditorId}) — {PluginDiagnosis.UnknownClass}:", refused.Message, StringComparison.Ordinal);
        Assert.Contains(Diagnosis, refused.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.ChangedFormKeys(_destinationPlugin));
        Assert.Null(_mod.Document(_destinationPlugin, UnreadablePerk));
    }

    [Fact]
    public void CopyRecordAsNewRecord_OfAParseFailedRecord_IsRefusedWithItsDiagnosis_AndWritesNothing()
    {
        var result = _mod.CopyHandler.CopySync([new RecordAt(_sourcePlugin, UnreadablePerk)], CopyMode.New, [_destinationPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.RecordParseFailed, refused.Refusal);
        Assert.Contains(Diagnosis, refused.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.ChangedFormKeys(_destinationPlugin));
    }

    [Fact]
    public void CopyRecordAsOverride_OfAReadablePerkFromTheSamePlugin_StillLands()
    {
        var readable = MisshapedPerkPlugin.ReadableFormKey;

        var result = _mod.CopyHandler.CopySync([new RecordAt(_sourcePlugin, readable)], CopyMode.Override, [_destinationPlugin], replace: false);

        result.OnlyLanded();
        Assert.NotNull(_mod.Document(_destinationPlugin, readable));
        Assert.Equal([readable], _mod.ChangedFormKeys(_destinationPlugin));
    }

    [Fact]
    public void CopyRecordAsNewRecord_OfAReadablePerkFromTheSamePlugin_StillLands()
    {
        var readable = MisshapedPerkPlugin.ReadableFormKey;

        var result = _mod.CopyHandler.CopySync([new RecordAt(_sourcePlugin, readable)], CopyMode.New, [_destinationPlugin], replace: false);

        var newFormKey = result.OnlyLanded().Require();
        Assert.NotNull(_mod.Document(_destinationPlugin, newFormKey));
        Assert.Equal(["000000:Destination.esp", newFormKey], _mod.ChangedFormKeys(_destinationPlugin));
    }
}

public sealed class ParseFailedDialogChildCopyRefusalTests : IDisposable
{
    private readonly ContainerCopyFixture _mod = ContainerCopyFixture.CreateWithCompiledPluginSource();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void CopyRecordAsNewRecord_OfADialogTopicWithAnUnreadableResponse_IsRefused_AndWritesNothing()
    {
        var quest = _mod.DocumentCarrying(_mod.SourcePlugin, ContainerCopyFixture.Response2EditorId);
        _mod.Overwrite(
            _mod.SourcePlugin,
            quest with
            {
                Body = quest.Body.Replace(
                    $"\"EditorID\": \"{ContainerCopyFixture.Response2EditorId}\"",
                    $"\"MajorRecordFlagsRaw\": \"notanumber\",\n\"EditorID\": \"{ContainerCopyFixture.Response2EditorId}\"",
                    StringComparison.Ordinal),
            });

        var result = _mod.CopyHandler.CopySync([new RecordAt(_mod.SourcePlugin, _mod.DialogTopic.ToString())], CopyMode.New, [_mod.DestinationPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.RecordParseFailed, refused.Refusal);
        Assert.Contains("Unable to cast", refused.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.ChangedFormKeys(_mod.DestinationPlugin));
        Assert.Null(_mod.Document(_mod.DestinationPlugin, _mod.Quest.ToString()));
    }
}

using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
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
}

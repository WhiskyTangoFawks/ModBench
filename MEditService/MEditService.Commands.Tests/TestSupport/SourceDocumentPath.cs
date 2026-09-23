using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>The file a record's own document sits in, asked of the repository.</summary>
public static class SourceDocumentPath
{
    public static string Of(
        string modFolder, string pluginFileName, string recordType, string formKey, string? editorId,
        GameRelease release)
    {
        var repository = SourceRepository.Open(modFolder, release) ?? SourceRepository.Over(modFolder, release);
        var unit = repository.UnitHolding(
            new PluginCopyKey(pluginFileName, "TestMod"), new RecordIdentity(formKey, recordType, editorId));

        return unit is null
            ? throw new InvalidOperationException(
                $"No document in {pluginFileName}'s tree under '{modFolder}' holds {formKey}.")
            : Path.Combine(modFolder, unit.RelativePath);
    }
}

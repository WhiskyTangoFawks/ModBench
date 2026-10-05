using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter.Tests.TestSupport;

/// <summary>The file a record's own document sits in, asked of the repository.</summary>
public static class SourceDocumentPath
{
    public static string Of(
        string modFolder, string pluginFileName, string recordType, string formKey, string? editorId,
        GameRelease release)
    {
        var repository = SourceRepository.Over(TestMod.In(modFolder), release);
        var relativePath = repository.RelativePathOf(
            new PluginAddress(pluginFileName, TestMod.Name), new RecordIdentity(formKey, recordType, editorId));

        return relativePath is null
            ? throw new InvalidOperationException(
                $"No document in {pluginFileName}'s tree under '{modFolder}' holds {formKey}.")
            : Path.Combine(modFolder, relativePath);
    }
}

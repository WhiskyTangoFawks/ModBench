using MEditService.Core.Records;
using MEditService.Core.Source;
using Mutagen.Bethesda;

namespace MEditService.Tests.TestSupport;

/// <summary>The file a record's document sits in, asked of the repository. A test computing the
/// path itself would need the order index Track chose, and would stop agreeing the moment
/// something renames the file.</summary>
internal static class SourceDocumentPath
{
    internal static string Of(
        string modFolder, string pluginFileName, string recordType, string formKey, string? editorId,
        GameRelease release)
    {
        var repository = SourceRepository.Open(modFolder, release) ?? SourceRepository.Over(modFolder, release);
        var unit = repository.Locate(new PluginKey(pluginFileName), new RecordIdentity(formKey, recordType, editorId));

        return unit?.FullPath
            ?? throw new InvalidOperationException(
                $"No document in {pluginFileName}'s tree under '{modFolder}' holds {formKey}.");
    }
}

using System.Text.Json;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Core.Ledger;

/// <summary>
/// Recovers a tracked record's field values as they stood at an earlier ledger commit (#371 AC3):
/// reads the committed text (<see cref="LedgerRepository.ReadTextAtCommit"/>, touching neither the
/// working tree nor the index), deserializes it (<see cref="RecordTextCodec"/> — the same codec
/// every ledger read/write already uses), and converts the result into wire-shaped fields
/// (<see cref="LedgerRecordFieldReader"/>). Returns field values only — staging them as a normal
/// edit (so the existing, unmodified Save path does the binary write and the new ledger commit,
/// per AC3's "re-applies to the binary through the normal save path") is the caller's job
/// (<c>EditOrchestrator.RevertRecordToLedgerCommitAsync</c>), not this class's.
/// </summary>
public sealed class RecordReverter(LedgerRepository ledger, RecordTextCodec codec, LedgerRecordFieldReader fieldReader)
{
    public async Task<Dictionary<string, JsonElement>> ReadFieldsAtCommitAsync(
        string originFolder,
        string pluginFileName,
        string recordType,
        Type concreteRecordType,
        string formKeyString,
        string commitish,
        RecordTableSchema schema,
        GameRelease release,
        CancellationToken cancel = default)
    {
        var relativePath = LedgerRecordPath.For(pluginFileName, recordType, formKeyString);
        var text = ledger.ReadTextAtCommit(originFolder, relativePath, commitish);

        // A temp file, not a temp string: RecordTextCodec.DeserializeAsync reads from a file path
        // (it is also the ledger's own working-tree write/read contract — see its own remarks), so
        // this reuses that contract rather than growing a second, string-based overload of it.
        var tempDir = Directory.CreateTempSubdirectory("medit-revert-");
        try
        {
            var tempFile = Path.Combine(tempDir.FullName, "record.yaml");
            await File.WriteAllTextAsync(tempFile, text, cancel).ConfigureAwait(false);

            var record = await codec.DeserializeAsync(tempFile, concreteRecordType, release, cancel).ConfigureAwait(false);
            return fieldReader.ReadFields(record, schema, pluginFileName, release);
        }
        finally
        {
            tempDir.Delete(recursive: true);
        }
    }
}

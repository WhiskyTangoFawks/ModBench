using System.Text.Json;
using MEditService.Core.Ledger;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #371 review (mutation axis, optional item): <see cref="RecordReverter"/>'s own temp-directory
/// cleanup, at its own public seam — the same precedent <c>PreparedPluginSave.Dispose</c>'s own
/// tmp-dir cleanup already has coverage for.
/// </summary>
public sealed class RecordReverterTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    [Fact]
    public async Task ReadFieldsAtCommitAsync_CleansUpItsOwnTempDirectoryOnSuccess()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-reverter-ledger-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-reverter-origin-").FullName;
        try
        {
            var ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
            var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
            var vendor = new RecordVendor(ledger, codec, NullLogger<RecordVendor>.Instance);
            var repositoryFactory = new DuckDbRecordRepositoryFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance));
            var reverter = new RecordReverter(ledger, codec, new LedgerRecordFieldReader(repositoryFactory));

            const string pluginFileName = "Vendor.esp";
            var pluginPath = Path.Combine(originFolder, pluginFileName);
            var mod = new Fallout4Mod(ModKey.FromFileName(pluginFileName), Fallout4Release.Fallout4);
            var npc = mod.Npcs.AddNew("ReverterNpc");
            mod.WriteToBinary(pluginPath);
            var formKey = npc.FormKey.ToString();

            await vendor.VendorAndStageDirtAsync(
                originFolder, pluginPath, pluginFileName, "npc_", typeof(Npc), formKey,
                new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") },
                Schemas, GameRelease.Fallout4);

            var (gitDir, workTree) = ledger.PathsFor(originFolder);
            var commitA = GitCli.Run(gitDir, workTree, "log", "-1", "--format=%H", "main").Trim();

            var before = Directory.GetDirectories(Path.GetTempPath(), "medit-revert-*").Length;

            var fields = await reverter.ReadFieldsAtCommitAsync(
                originFolder, pluginFileName, "npc_", typeof(Npc), formKey, commitA, Schemas["npc_"], GameRelease.Fallout4);

            Assert.NotEmpty(fields);
            var after = Directory.GetDirectories(Path.GetTempPath(), "medit-revert-*").Length;
            Assert.Equal(before, after);
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }
}

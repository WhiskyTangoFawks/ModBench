using MEditService.Core.Commands;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace MEditService.Core.Composition;

/// <summary>Where the gesture handlers are built (ADR-0046 invariant 3), because only this assembly
/// can name the internal module they share. The host calls this one method.</summary>
public static class CommandHandlers
{
    public static IServiceCollection AddCommandHandlers(this IServiceCollection services)
    {
        // One instance for the write side: it holds singletons and decides nothing per request, and
        // a handler that built its own would answer from the same four.
        services.AddSingleton(sp => new WriteTargets(
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<IModImporter>(),
            sp.GetRequiredService<RecordTextCodec>(),
            sp.GetRequiredService<SchemaReflector>(),
            sp.GetRequiredService<ILoggerFactory>().CreateLogger(nameof(WriteTargets))));

        services.AddSingleton(sp => new EditRecordHandler(
            sp.GetRequiredService<WriteTargets>(),
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<Func<LoadOrder, FormLinkResolver>>(),
            sp.GetRequiredService<RecordTextCodec>(),
            sp.GetRequiredService<SchemaReflector>(),
            sp.GetRequiredService<ILogger<EditRecordHandler>>()));

        services.AddSingleton(sp => new DeleteRecordHandler(
            sp.GetRequiredService<WriteTargets>(),
            sp.GetRequiredService<ILogger<DeleteRecordHandler>>()));

        services.AddSingleton(sp => new CreateRecordHandler(
            sp.GetRequiredService<WriteTargets>(),
            sp.GetRequiredService<LoadOrderHolder>(),
            sp.GetRequiredService<RecordTextCodec>(),
            sp.GetRequiredService<SchemaReflector>(),
            sp.GetRequiredService<ILogger<CreateRecordHandler>>()));

        services.AddSingleton(sp => new PeekNextFreeFormKeyHandler(
            sp.GetRequiredService<WriteTargets>(),
            sp.GetRequiredService<LoadOrderHolder>()));

        return services;
    }
}

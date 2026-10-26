using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>Why a gesture cannot make a folder whose manifest holds a step: each step runs a VS Code task, which the
/// backend cannot run.</summary>
internal static class StepsNotRun
{
    public static string? Why(Manifest manifest, string gesture) =>
        manifest.Steps is [var step, ..] ? $"its step '{step.Task}' runs a VS Code task, which {gesture} cannot run" : null;
}

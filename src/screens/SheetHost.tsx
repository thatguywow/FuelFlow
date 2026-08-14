import { lazy, Suspense } from 'react';
import { useUi } from '../state/ui';
import AddFood from './AddFood';
import FoodDetail from './FoodDetail';
import NutrientDetail from './NutrientDetail';
import { CreateFood, LogExercise, LogWeight, QuickAddSheet } from './Sheets';

// Scanner pulls in camera and decoding code; quick log pulls in the parser.
// Neither belongs in the initial download.
const Scanner = lazy(() => import('./Scanner'));
const LabelScanner = lazy(() => import('./LabelScanner'));
const QuickLog = lazy(() => import('./QuickLog'));
const Goals = lazy(() => import('./Goals'));
const Water = lazy(() => import('./Water'));

/**
 * Single mount point for every modal in the app.
 *
 * Sheets are described by a discriminated union in the UI store rather than by
 * routes, which keeps deep state (the food being edited, the day being logged
 * into) type-safe and makes "close everything" a one-line operation.
 */
export default function SheetHost() {
  const sheet = useUi((s) => s.sheet);

  if (sheet.kind === 'none') return null;

  return (
    <Suspense fallback={null}>
      {sheet.kind === 'add-food' && <AddFood mealId={sheet.mealId} day={sheet.day} />}
      {sheet.kind === 'food-detail' && (
        <FoodDetail food={sheet.food} mealId={sheet.mealId} day={sheet.day} entryId={sheet.entryId} />
      )}
      {sheet.kind === 'quick-log' && <QuickLog mealId={sheet.mealId} day={sheet.day} />}
      {sheet.kind === 'quick-add' && <QuickAddSheet mealId={sheet.mealId} day={sheet.day} />}
      {sheet.kind === 'scanner' && <Scanner mealId={sheet.mealId} day={sheet.day} />}
      {sheet.kind === 'label-scanner' && <LabelScanner mealId={sheet.mealId} day={sheet.day} />}
      {sheet.kind === 'nutrient-detail' && <NutrientDetail day={sheet.day} />}
      {sheet.kind === 'log-weight' && <LogWeight />}
      {sheet.kind === 'log-exercise' && <LogExercise day={sheet.day} />}
      {sheet.kind === 'water' && <Water day={sheet.day} />}
      {sheet.kind === 'create-food' && (
        <CreateFood barcode={sheet.barcode} mealId={sheet.mealId} day={sheet.day} />
      )}
      {sheet.kind === 'goals' && <Goals />}
    </Suspense>
  );
}
